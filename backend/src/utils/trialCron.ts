import cron from 'node-cron';
import { prisma } from '../db.js';
import { sendEmail } from './email.js';

// ---------------------------------------------------------------------------
// Trial-end watchdog. Runs daily for every garage on a trial that has not yet
// set up a way to pay:
//   • 7 / 3 / 1 days before trialEndDate → "set up payment" reminder
//   • on/after trialEndDate              → lock the account (accessRestricted)
//
// This used to cover Connect only — the query asked for hasVoiceAccess: false —
// so an Assist or Automate trial got no reminder and was never locked. Its trial
// simply ended and nothing happened, which left conversion depending on somebody
// remembering. Kestrels started an Assist trial on 2026-08-19 and would not have
// been covered.
//
// How they pay differs by product, so the reminder has to ask for the right thing:
//   Automate        → Direct Debit via GoCardless (/setup-payment)
//   Assist, Connect → card via Stripe (the dashboard paywall)
// Asking an Automate customer for a card, or a Connect customer for a Direct
// Debit, is a dead end for them — hence the branch rather than one generic email.
//
// Once payment is set up the garage drops out of the sweep: the Stripe webhook
// clears accessRestricted, and a GoCardless mandate satisfies the check below.
// ---------------------------------------------------------------------------

const PORTAL_URL = process.env.PORTAL_URL || 'https://portal.receptionmate.co.uk';

type Product = 'connect' | 'assist' | 'automate';

interface TrialGarage {
  id: string;
  name: string;
  trialEndDate: Date | null;
  accessRestricted: boolean;
  hasVoiceAccess: boolean;
  hasMessagingAccess: boolean;
  stripeSubscriptionId: string | null;
  stripeCustomerId: string | null;
  subscriptionCostGbp: number | null;
  business: { contactEmail: string | null } | null;
  agentConfiguration: { agentType: string | null } | null;
}

function productOf(g: TrialGarage): Product {
  if (!g.hasVoiceAccess && g.hasMessagingAccess) return 'connect';
  return g.agentConfiguration?.agentType === 'assist' ? 'assist' : 'automate';
}

/** Where this product sends someone to start paying. */
function payment(product: Product): { url: string; label: string; what: string } {
  return product === 'automate'
    ? { url: `${PORTAL_URL}/setup-payment`, label: 'Set up my Direct Debit', what: 'a Direct Debit' }
    : { url: `${PORTAL_URL}/dashboard`, label: 'Add my card', what: 'a card' };
}

function priceLine(g: TrialGarage): string {
  const cost = Number(g.subscriptionCostGbp || 0);
  return cost > 0 ? `It's £${cost % 1 === 0 ? cost : cost.toFixed(2)} + VAT a month, and you can cancel anytime.` : '';
}

function shell(inner: string): string {
  return `<div style="font-family:Inter,system-ui,sans-serif;max-width:560px;margin:0 auto;color:#0f172a;">${inner}
    <p style="color:#64748b;font-size:13px;">— The ReceptionMate team</p></div>`;
}

function button(url: string, label: string): string {
  return `<p style="text-align:center;margin:28px 0;"><a href="${url}" style="display:inline-block;background:#3426cf;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;">${label}</a></p>`;
}

function reminderHtml(g: TrialGarage, daysLeft: number): string {
  const p = payment(productOf(g));
  const day = daysLeft === 1 ? 'day' : 'days';
  return shell(`<h2 style="color:#3426cf;">Your trial ends in ${daysLeft} ${day}</h2>
    <p>Hi ${g.name},</p>
    <p>Your ReceptionMate trial is nearly up. To keep your AI answering, please set up ${p.what} before it ends. ${priceLine(g)}</p>
    ${button(p.url, p.label)}
    <p style="color:#94a3b8;font-size:13px;">If you don't, your AI will pause when the trial ends — no charge, nothing to cancel.</p>`);
}

function endedHtml(g: TrialGarage): string {
  const p = payment(productOf(g));
  return shell(`<h2 style="color:#3426cf;">Your trial has ended</h2>
    <p>Hi ${g.name},</p>
    <p>Your ReceptionMate trial is over, so your AI has paused. Set up ${p.what} to switch it back on. ${priceLine(g)}</p>
    ${button(p.url, p.label)}`);
}

/** True when this garage already has a way to pay, so it should be left alone. */
async function canPay(g: TrialGarage): Promise<boolean> {
  if (productOf(g) === 'automate') {
    // Automate bills by Direct Debit, and the mandate lives on the user, not the garage.
    const mandated = await prisma.user.findFirst({
      where: { garageAccessIds: { has: g.id }, gocardlessMandateId: { not: null } },
      select: { id: true },
    });
    return !!mandated;
  }
  return !!(g.stripeSubscriptionId || g.stripeCustomerId);
}

async function contactFor(g: TrialGarage): Promise<string | null> {
  if (g.business?.contactEmail) return g.business.contactEmail;
  const u = await prisma.user.findFirst({
    where: { garageAccessIds: { has: g.id } },
    select: { email: true },
  });
  return u?.email || null;
}

/**
 * Render the reminder exactly as a garage would receive it, without sending it to them.
 *
 * Used to preview a trial email before it goes out — the same builders the cron uses, so what you
 * check is what they get rather than an approximation of it.
 */
export async function buildTrialEmail(
  garageId: string,
  daysLeft: number,
): Promise<{ subject: string; html: string; text: string; product: Product; to: string | null } | null> {
  const g = (await prisma.garage.findUnique({
    where: { id: garageId },
    select: {
      id: true, name: true, trialEndDate: true, accessRestricted: true,
      hasVoiceAccess: true, hasMessagingAccess: true,
      stripeSubscriptionId: true, stripeCustomerId: true, subscriptionCostGbp: true,
      business: { select: { contactEmail: true } },
      agentConfiguration: { select: { agentType: true } },
    },
  })) as unknown as TrialGarage | null;
  if (!g) return null;
  const product = productOf(g);
  const ended = daysLeft <= 0;
  return {
    subject: ended
      ? 'Your ReceptionMate trial has ended'
      : `Your ReceptionMate trial ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`,
    html: ended ? endedHtml(g) : reminderHtml(g, daysLeft),
    text: ended
      ? `Your trial has ended and your AI has paused. Set up ${payment(product).what}: ${payment(product).url}`
      : `Your trial ends in ${daysLeft} day(s). Set up ${payment(product).what}: ${payment(product).url}`,
    product,
    to: await contactFor(g),
  };
}

export async function runTrialCheck(): Promise<void> {
  const now = new Date();
  const garages = (await prisma.garage.findMany({
    where: {
      trialEndDate: { not: null },
      archivedAt: null,
      isTestAccount: false,
    },
    select: {
      id: true, name: true, trialEndDate: true, accessRestricted: true,
      hasVoiceAccess: true, hasMessagingAccess: true,
      stripeSubscriptionId: true, stripeCustomerId: true, subscriptionCostGbp: true,
      business: { select: { contactEmail: true } },
      agentConfiguration: { select: { agentType: true } },
    },
  })) as unknown as TrialGarage[];

  for (const g of garages) {
    if (!g.trialEndDate) continue;
    if (await canPay(g)) continue;

    const daysLeft = Math.ceil((g.trialEndDate.getTime() - now.getTime()) / 86_400_000);
    const email = await contactFor(g);
    const product = productOf(g);

    if (daysLeft <= 0) {
      if (g.accessRestricted) continue;         // already locked, nothing to do
      await prisma.garage.update({ where: { id: g.id }, data: { accessRestricted: true } });
      console.log(`[TRIAL] locked ${g.name} (${product}) — trial ended`);
      if (email) {
        await sendEmail({
          to: [email],
          subject: 'Your ReceptionMate trial has ended',
          html: endedHtml(g),
          text: `Your trial has ended and your AI has paused. Set up ${payment(product).what} to switch it back on: ${payment(product).url}`,
        }).catch((e) => console.error('[TRIAL] ended email failed', e));
      }
    } else if (daysLeft === 7 || daysLeft === 3 || daysLeft === 1) {
      console.log(`[TRIAL] ${daysLeft}d reminder -> ${g.name} (${product})`);
      if (email) {
        await sendEmail({
          to: [email],
          subject: `Your ReceptionMate trial ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`,
          html: reminderHtml(g, daysLeft),
          text: `Your trial ends in ${daysLeft} day(s). Set up ${payment(product).what}: ${payment(product).url}`,
        }).catch((e) => console.error('[TRIAL] reminder email failed', e));
      }
    }
  }
}

/**
 * Cancel Stripe subscriptions left behind by signups that never became accounts.
 *
 * Signing creates a trialing subscription before a card is entered, so an abandoned signup leaves
 * a live subscription for a garage that does not exist. It will try to bill at trial end, fail,
 * and cancel itself — but it pollutes Stripe in the meantime and produces failed-payment noise
 * against a customer nobody can look up. Tidy them once the signup has expired.
 */
export async function cancelAbandonedSignupSubscriptions(): Promise<number> {
  const stale = await prisma.pendingSignup.findMany({
    where: {
      stripeSubscriptionId: { not: null },
      createdGarageId: null,
      expiresAt: { lt: new Date() },
    },
    select: { id: true, businessName: true, stripeSubscriptionId: true },
  });
  if (!stale.length) return 0;

  let cancelled = 0;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return 0;
  const { default: Stripe } = await import('stripe');
  const stripe = new Stripe(key);

  for (const s of stale) {
    try {
      const sub = await stripe.subscriptions.retrieve(s.stripeSubscriptionId as string);
      if (sub.status === 'canceled' || sub.status === 'incomplete_expired') continue;
      await stripe.subscriptions.cancel(s.stripeSubscriptionId as string);
      cancelled += 1;
      console.log(`[TRIAL] cancelled orphaned subscription for "${s.businessName}" — signup expired without an account`);
    } catch (err) {
      console.error(`[TRIAL] could not cancel ${s.stripeSubscriptionId}:`, (err as Error).message);
    }
  }
  return cancelled;
}

export function initTrialCron(): void {
  // Daily at 09:30 UK, after the 09:00 billing jobs.
  cron.schedule('30 9 * * *', () => {
    void runTrialCheck().catch((e) => console.error('[TRIAL] cron error', e));
    void cancelAbandonedSignupSubscriptions().catch((e) => console.error('[TRIAL] cleanup error', e));
  }, { timezone: 'Europe/London' });
  console.log('✓ Trial-end check scheduled: daily at 9:30 AM (UK time), all products');
}
