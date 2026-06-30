// Stripe webhook handler. Stripe POSTs here when a `checkout.session.completed`
// event fires — i.e. the customer has paid for their first month. This is
// where we provision the actual account: buy a Twilio number, set up the
// SIP trunk, generate a paid invoice, send welcome email.
//
// Provisioning lives here (not in `/public-signup`) so we never spend money
// on Twilio numbers for customers who never actually paid.

import type { Request, Response } from 'express';
import { Router } from 'express';
import express from 'express';
import Stripe from 'stripe';
import { prisma } from '../../db.js';
import { sendWelcomeEmail } from '../../utils/email.js';
import { getStripeClient } from '../../services/stripe.js';
import { purchaseRandomTwilioNumber } from '../onboarding.js';

const router = Router();

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? '';
const PORTAL_URL = process.env.PORTAL_URL || 'https://portal.receptionmate.co.uk';
const ONBOARDING_SERVICE_URL = process.env.ONBOARDING_SERVICE_URL || 'http://localhost:3002';
const ONBOARDING_SECRET = process.env.ONBOARDING_SECRET;

// Stripe requires the raw (un-parsed) body for signature verification.
// Mounting `express.raw` here so this route bypasses the global `json()`.
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

    if (event.type !== 'checkout.session.completed') {
      // Not interested — return 200 so Stripe doesn't keep retrying.
      return res.json({ received: true });
    }

    const session = event.data.object as Stripe.Checkout.Session;
    const meta = session.metadata || {};

    // Only handle first-month signups; ignore other Checkout sessions
    // (e.g. if we add more Stripe products later, they won't accidentally
    //  trigger account provisioning).
    if (meta.kind !== 'first-month-assist') {
      return res.json({ received: true, ignored: 'wrong-kind' });
    }

    if (!meta.userId || !meta.garageId) {
      console.error('[STRIPE_WEBHOOK] missing metadata:', meta);
      return res.status(400).send('Missing userId/garageId metadata');
    }

    // Idempotency — Stripe may deliver the same event more than once. If we
    // already provisioned this signup (twilio number exists), skip.
    const existingGarage = await prisma.garage.findUnique({
      where: { id: meta.garageId },
      select: { id: true, name: true, twilioNumber: true, businessId: true, subscriptionCostGbp: true, includedMinutes: true, costPerMinuteGbp: true, vatRate: true },
    });
    if (!existingGarage) {
      console.error('[STRIPE_WEBHOOK] garage not found:', meta.garageId);
      return res.status(404).send('Garage not found');
    }
    if (existingGarage.twilioNumber) {
      console.log(`[STRIPE_WEBHOOK] garage ${meta.garageId} already provisioned, skipping`);
      return res.json({ received: true, alreadyProvisioned: true });
    }

    const user = await prisma.user.findUnique({ where: { id: meta.userId } });
    if (!user) {
      console.error('[STRIPE_WEBHOOK] user not found:', meta.userId);
      return res.status(404).send('User not found');
    }

    // ============ PROVISION ============

    // 1. Buy a Twilio number + provision the SIP trunk.
    let twilioNumber: string | null = null;
    try {
      twilioNumber = await purchaseRandomTwilioNumber();

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (ONBOARDING_SECRET) headers['x-onboarding-secret'] = ONBOARDING_SECRET;

      const onboardResponse = await fetch(`${ONBOARDING_SERVICE_URL}/provision`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          garageId: existingGarage.id,
          garageName: existingGarage.name,
          branchName: existingGarage.name,
          contactEmail: user.email,
          twilioNumber,
          agentName: 'receptionmate-agent',
          triggeredAt: new Date().toISOString(),
        }),
      });

      if (!onboardResponse.ok) {
        const text = await onboardResponse.text().catch(() => '');
        throw new Error(`Onboarding service ${onboardResponse.status}: ${text.slice(0, 200)}`);
      }

      await prisma.garage.update({
        where: { id: existingGarage.id },
        data: { twilioNumber },
      });
    } catch (err) {
      // Don't fail the webhook — the customer has paid. Log loudly so the
      // team can manually assign a number from the admin UI.
      console.error(`[STRIPE_WEBHOOK] Twilio provisioning failed for user=${user.id} garage=${existingGarage.id}:`, err);
    }

    // 2. Generate the paid first-month invoice.
    const subscriptionAmount = Math.round(existingGarage.subscriptionCostGbp * 100);
    const vatAmount = Math.round(subscriptionAmount * existingGarage.vatRate);
    const total = subscriptionAmount + vatAmount;
    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setMonth(periodEnd.getMonth() + 1);

    try {
      await prisma.invoice.create({
        data: {
          garageId: existingGarage.id,
          businessId: existingGarage.businessId ?? null,
          userId: user.id,
          periodStart: now,
          periodEnd,
          minutesUsed: 0,
          minutesIncluded: existingGarage.includedMinutes,
          smsCount: 0,
          subscriptionAmount,
          minutesAmount: 0,
          smsAmount: 0,
          subtotal: subscriptionAmount,
          vatAmount,
          total,
          subscriptionCostGbp: existingGarage.subscriptionCostGbp,
          costPerMinuteGbp: existingGarage.costPerMinuteGbp,
          vatRate: existingGarage.vatRate,
          status: 'paid',
          paidAt: new Date(),
          // We don't (yet) have a `stripeSessionId` column on Invoice — we
          // park the session ID in `gocardlessPaymentId` so support can
          // reconcile in Stripe's dashboard by ID. Add a proper column on
          // the next schema bump if this ambiguity becomes painful.
          gocardlessPaymentId: session.id,
        },
      });
    } catch (err) {
      console.error('[STRIPE_WEBHOOK] invoice create failed:', err);
    }

    // 3. Send welcome email with login credentials. Same password as before
    //    (`Nomoremissedcalls`); `mustChangePassword=true` forces a change.
    try {
      await sendWelcomeEmail({
        to: user.email,
        businessName: existingGarage.name,
        branchName: existingGarage.name,
        email: user.email,
        password: 'Nomoremissedcalls',
        portalUrl: PORTAL_URL,
      });
    } catch (err) {
      console.error('[STRIPE_WEBHOOK] welcome email failed:', err);
    }

    console.log(`[STRIPE_WEBHOOK] provisioned signup user=${user.id} garage=${existingGarage.id} twilio=${twilioNumber ?? 'FAILED'} session=${session.id}`);
    return res.json({ received: true, provisioned: true });
  },
);

export default router;
