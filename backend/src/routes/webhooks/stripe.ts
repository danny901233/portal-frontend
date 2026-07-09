// Stripe webhook handler for NEW Assist self-serve signups on the 14-day-trial subscription.
// (Existing GoCardless Direct Debit customers are handled entirely separately and never appear
// here — they have no stripeSubscriptionId, so the lookups below simply never match them.)
//
// Events handled:
//   setup_intent.succeeded       → card confirmed (custom Payment Element): provision Twilio/SIP + welcome
//   checkout.session.completed   → same, for any legacy hosted-checkout session still in flight
//   invoice.payment_succeeded    → day-14 (and monthly) charge landed: record a paid invoice
//   invoice.payment_failed       → charge failed: log + notify (Stripe auto-retries/dunning)
//   customer.subscription.deleted→ subscription cancelled: log + notify the team

import type { Request, Response } from 'express';
import { Router } from 'express';
import express from 'express';
import Stripe from 'stripe';
import { prisma } from '../../db.js';
import { sendWelcomeEmail, sendEmail } from '../../utils/email.js';
import { getStripeClient, STRIPE_TRIAL_DAYS } from '../../services/stripe.js';
import { purchaseRandomTwilioNumber } from '../onboarding.js';
import { sendAgentConfigWebhook } from '../config.js';
import { updateOpportunity, LIVE_STAGE_ID } from '../../services/highlevel.js';

const router = Router();

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? '';
const PORTAL_URL = process.env.PORTAL_URL || 'https://portal.receptionmate.co.uk';
const ONBOARDING_SERVICE_URL = process.env.ONBOARDING_SERVICE_URL || 'http://localhost:3002';
const ONBOARDING_SECRET = process.env.ONBOARDING_SECRET;
const OPS_EMAIL = 'hello@receptionmate.co.uk';

// The subscription reference has moved around across Stripe API versions (top-level
// `invoice.subscription`, then `invoice.parent.subscription_details`, and on the line items).
// Read it defensively so a version bump can't silently break the garage lookup.
function invoiceSubId(invoice: Stripe.Invoice): string | undefined {
  const inv = invoice as unknown as Record<string, any>;
  const sub =
    inv.subscription ??
    inv.parent?.subscription_details?.subscription ??
    inv.lines?.data?.[0]?.subscription ??
    inv.lines?.data?.[0]?.parent?.subscription_item_details?.subscription;
  return typeof sub === 'string' ? sub : sub?.id;
}

// ── provisioning core: buy a Twilio number, set up the SIP trunk, send the welcome email ──
// Idempotent by contract: the caller must skip this if the garage already has a number.
async function provisionGarageAccount(garage: { id: string; name: string }, userEmail: string): Promise<void> {
  // Match the portal voice webhook's routing: Assist/GarageHive garages run on LiveKit Account 2
  // with their own agent; everything else stays on Account 1. Get this wrong and the number rings
  // into a LiveKit project with no matching trunk — the call goes nowhere.
  const cfg = await prisma.agentConfiguration.findUnique({
    where: { garageId: garage.id },
    select: { agentScript: true },
  });
  const agentScript = cfg?.agentScript || 'receptionmate-agent';
  const account = agentScript === 'Assist-agent' || agentScript === 'GarageHive-agent' ? 'account2' : 'account1';

  let twilioNumber: string | null = null;
  try {
    twilioNumber = await purchaseRandomTwilioNumber();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (ONBOARDING_SECRET) headers['x-onboarding-secret'] = ONBOARDING_SECRET;
    const onboardResponse = await fetch(`${ONBOARDING_SERVICE_URL}/provision`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        garageId: garage.id,
        garageName: garage.name,
        branchName: garage.name,
        contactEmail: userEmail,
        twilioNumber,
        agentName: agentScript,
        account,
        triggeredAt: new Date().toISOString(),
      }),
    });
    if (!onboardResponse.ok) {
      const text = await onboardResponse.text().catch(() => '');
      throw new Error(`Onboarding service ${onboardResponse.status}: ${text.slice(0, 200)}`);
    }
    await prisma.garage.update({ where: { id: garage.id }, data: { twilioNumber } });
  } catch (err) {
    console.error(`[STRIPE_WEBHOOK] Twilio provisioning failed for garage=${garage.id}:`, err);
    // Don't throw — the trial has started; the team can assign a number manually.
  }

  // Push the garage's agent config to the live agent (DynamoDB). Self-serve signups never saved
  // config in the portal, so this is the FIRST push — without it the number rings but the agent
  // has no config to load and the call goes nowhere.
  try {
    await sendAgentConfigWebhook(garage.id);
  } catch (err) {
    console.error(`[STRIPE_WEBHOOK] agent config sync failed for garage=${garage.id}:`, err);
  }

  try {
    await sendWelcomeEmail({
      to: userEmail,
      businessName: garage.name,
      branchName: garage.name,
      email: userEmail,
      password: 'Nomoremissedcalls',
      portalUrl: PORTAL_URL,
    });
  } catch (err) {
    console.error('[STRIPE_WEBHOOK] welcome email failed:', err);
  }

  console.log(`[STRIPE_WEBHOOK] provisioned garage=${garage.id} twilio=${twilioNumber ?? 'FAILED'}`);
}

// ── custom Payment Element path: card confirmed against the trial subscription's SetupIntent ──
// We stored garage.stripeCustomerId when the subscription was created, so map back by customer id.
async function handleSetupIntentSucceeded(si: Stripe.SetupIntent): Promise<void> {
  const customerId = typeof si.customer === 'string' ? si.customer : si.customer?.id ?? null;
  if (!customerId) return;
  const garage = await prisma.garage.findFirst({
    where: { stripeCustomerId: customerId },
    select: { id: true, name: true, twilioNumber: true },
  });
  if (!garage) return; // not one of ours
  if (garage.twilioNumber) {
    console.log(`[STRIPE_WEBHOOK] garage ${garage.id} already provisioned, skipping`);
    return;
  }
  const user = await prisma.user.findFirst({
    where: { garageAccessIds: { has: garage.id } },
    select: { email: true },
  });
  if (!user) { console.error('[STRIPE_WEBHOOK] no user for garage', garage.id); return; }
  await provisionGarageAccount({ id: garage.id, name: garage.name }, user.email);
}

// ── legacy hosted Stripe Checkout path — kept for any in-flight hosted sessions ──
async function handleCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
  const meta = session.metadata || {};
  if (meta.kind !== 'assist-trial' || !meta.garageId || !meta.userId) return;
  const garage = await prisma.garage.findUnique({
    where: { id: meta.garageId },
    select: { id: true, name: true, twilioNumber: true },
  });
  if (!garage) return;
  const user = await prisma.user.findUnique({ where: { id: meta.userId }, select: { email: true } });
  if (!user) return;
  const trialEndsAt = new Date(Date.now() + STRIPE_TRIAL_DAYS * 24 * 60 * 60 * 1000);
  await prisma.garage.update({
    where: { id: garage.id },
    data: {
      stripeCustomerId: typeof session.customer === 'string' ? session.customer : session.customer?.id ?? null,
      stripeSubscriptionId: typeof session.subscription === 'string' ? session.subscription : session.subscription?.id ?? null,
      trialEndsAt,
    },
  });
  if (garage.twilioNumber) {
    console.log(`[STRIPE_WEBHOOK] garage ${garage.id} already provisioned, skipping`);
    return;
  }
  await provisionGarageAccount({ id: garage.id, name: garage.name }, user.email);
}

// ── a subscription charge landed (day 14 + monthly): record a paid invoice ──
async function handleInvoicePaid(invoice: Stripe.Invoice): Promise<void> {
  const subId = invoiceSubId(invoice);
  if (!subId) return;
  const garage = await prisma.garage.findFirst({
    where: { stripeSubscriptionId: subId },
    select: { id: true, businessId: true, includedMinutes: true, subscriptionCostGbp: true, costPerMinuteGbp: true, vatRate: true, subscriptionActivatedAt: true, ghlOpportunityId: true },
  });
  if (!garage) return; // not one of ours (e.g. an existing DD customer) — ignore

  // Idempotency: we park the Stripe invoice id in gocardlessPaymentId (no dedicated column yet).
  const already = await prisma.invoice.findFirst({ where: { gocardlessPaymentId: invoice.id } });
  if (already) return;

  const user = await prisma.user.findFirst({ where: { garageAccessIds: { has: garage.id } }, select: { id: true } });
  const subscriptionAmount = Math.round(garage.subscriptionCostGbp * 100);
  const vatAmount = Math.round(subscriptionAmount * garage.vatRate);
  const periodStart = invoice.period_start ? new Date(invoice.period_start * 1000) : new Date();
  const periodEnd = invoice.period_end ? new Date(invoice.period_end * 1000) : new Date();

  await prisma.invoice.create({
    data: {
      garageId: garage.id,
      businessId: garage.businessId ?? null,
      userId: user?.id ?? null,
      periodStart, periodEnd,
      minutesUsed: 0,
      minutesIncluded: garage.includedMinutes,
      smsCount: 0,
      subscriptionAmount,
      minutesAmount: 0,
      smsAmount: 0,
      subtotal: subscriptionAmount,
      vatAmount,
      total: subscriptionAmount + vatAmount,
      subscriptionCostGbp: garage.subscriptionCostGbp,
      costPerMinuteGbp: garage.costPerMinuteGbp,
      vatRate: garage.vatRate,
      status: 'paid',
      paidAt: new Date(),
      gocardlessPaymentId: invoice.id, // Stripe invoice id, for reconciliation
    },
  });

  // First successful charge = trial converted → mark the garage activated, and
  // promote its HighLevel opportunity from "Free trial live" to "Live and £££".
  if (!garage.subscriptionActivatedAt) {
    await prisma.garage.update({ where: { id: garage.id }, data: { subscriptionActivatedAt: new Date() } });
    if (garage.ghlOpportunityId && (invoice.amount_paid ?? 0) > 0) {
      void updateOpportunity(garage.ghlOpportunityId, {
        stageId: LIVE_STAGE_ID,
        monetaryValueGbp: garage.subscriptionCostGbp,
      }).then((ok) =>
        console.log(`[STRIPE_WEBHOOK] HL opportunity ${garage.ghlOpportunityId} → Live (${ok ? 'ok' : 'failed'})`),
      );
    }
  }
  console.log(`[STRIPE_WEBHOOK] invoice paid garage=${garage.id} stripeInvoice=${invoice.id} £${(invoice.amount_paid ?? 0) / 100}`);
}

// ── a subscription charge failed: log + notify (Stripe handles retries/dunning itself) ──
async function handleInvoiceFailed(invoice: Stripe.Invoice): Promise<void> {
  const subId = invoiceSubId(invoice);
  if (!subId) return;
  const garage = await prisma.garage.findFirst({ where: { stripeSubscriptionId: subId }, select: { id: true, name: true } });
  if (!garage) return;
  console.warn(`[STRIPE_WEBHOOK] invoice payment FAILED garage=${garage.id} (${garage.name}) stripeInvoice=${invoice.id}`);
  void sendEmail({
    to: [OPS_EMAIL],
    subject: `Assist payment failed — ${garage.name}`,
    text: `Stripe subscription payment failed for ${garage.name} (garage ${garage.id}, invoice ${invoice.id}). Stripe will retry automatically; check the dashboard if it keeps failing.`,
    html: `<p>Stripe subscription payment failed for <strong>${garage.name}</strong> (garage ${garage.id}, invoice ${invoice.id}).</p><p>Stripe will retry automatically (dunning); check the dashboard if it keeps failing.</p>`,
  }).catch(() => {});
}

// ── subscription cancelled (trial cancelled, or dunning gave up): log + notify the team ──
async function handleSubscriptionDeleted(subscription: Stripe.Subscription): Promise<void> {
  const garage = await prisma.garage.findFirst({ where: { stripeSubscriptionId: subscription.id }, select: { id: true, name: true } });
  if (!garage) return;
  console.warn(`[STRIPE_WEBHOOK] subscription cancelled garage=${garage.id} (${garage.name}) sub=${subscription.id}`);
  void sendEmail({
    to: [OPS_EMAIL],
    subject: `Assist subscription cancelled — ${garage.name}`,
    text: `The Stripe subscription for ${garage.name} (garage ${garage.id}) was cancelled. Review and deprovision (release the number / stop routing) if appropriate.`,
    html: `<p>The Stripe subscription for <strong>${garage.name}</strong> (garage ${garage.id}) was cancelled.</p><p>Review and deprovision (release the number / stop routing) if appropriate.</p>`,
  }).catch(() => {});
}

// Stripe requires the raw (un-parsed) body for signature verification.
router.post(
  '/stripe',
  express.raw({ type: 'application/json' }),
  async (req: Request, res: Response) => {
    if (!STRIPE_WEBHOOK_SECRET) {
      console.error('[STRIPE_WEBHOOK] STRIPE_WEBHOOK_SECRET not set; rejecting.');
      return res.status(500).send('Webhook secret not configured');
    }
    const signature = req.headers['stripe-signature'];
    if (!signature || typeof signature !== 'string') {
      return res.status(400).send('Missing stripe-signature header');
    }
    let event: Stripe.Event;
    try {
      const stripe = getStripeClient();
      event = stripe.webhooks.constructEvent(req.body as Buffer, signature, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error('[STRIPE_WEBHOOK] signature verification failed:', err);
      return res.status(400).send(`Webhook Error: ${(err as Error).message}`);
    }

    try {
      switch (event.type) {
        case 'checkout.session.completed':
          await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
          break;
        case 'setup_intent.succeeded':
          await handleSetupIntentSucceeded(event.data.object as Stripe.SetupIntent);
          break;
        case 'invoice.payment_succeeded':
          await handleInvoicePaid(event.data.object as Stripe.Invoice);
          break;
        case 'invoice.payment_failed':
          await handleInvoiceFailed(event.data.object as Stripe.Invoice);
          break;
        case 'customer.subscription.deleted':
          await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
          break;
        default:
          // ignore everything else
          break;
      }
    } catch (err) {
      // Log but return 200 so Stripe doesn't hammer us — our handlers are idempotent.
      console.error(`[STRIPE_WEBHOOK] handler error for ${event.type}:`, err);
    }
    return res.json({ received: true });
  },
);

export default router;
