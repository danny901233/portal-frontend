// Stripe billing for NEW Assist self-serve signups. These customers go on a Stripe
// subscription with a 14-day free trial: the card is captured at signup, nothing is charged
// for 14 days, then Stripe auto-charges monthly. EXISTING customers stay on GoCardless Direct
// Debit (the separate billing infrastructure) and never touch any of this.
//
// Flow:
//   1. Customer signs agreement → backend opens a Stripe Checkout (subscription + 14-day trial)
//   2. Customer enters their card on Stripe Checkout (no charge — trial)
//   3. `checkout.session.completed` webhook → provision Twilio/SIP + welcome email (go live now)
//   4. On day 14 (and monthly after) `invoice.payment_succeeded` → mark the invoice paid
//      `invoice.payment_failed` → dunning; `customer.subscription.deleted` → suspend

import Stripe from 'stripe';

const STRIPE_SECRET_KEY       = process.env.STRIPE_SECRET_KEY ?? '';
// The recurring monthly Price (created on the Stripe account). £240/mo incl 20% VAT.
const STRIPE_ASSIST_PRICE_ID  = process.env.STRIPE_ASSIST_PRICE_ID ?? '';
const TRIAL_DAYS              = Number(process.env.STRIPE_TRIAL_DAYS ?? 14);
const PORTAL_URL = (process.env.PORTAL_URL || 'https://portal.receptionmate.co.uk').replace(/\/$/, '');

let stripeClient: Stripe | null = null;

export function getStripeClient(): Stripe {
  if (!STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is not configured');
  }
  if (stripeClient) return stripeClient;
  // Pin the API version so a Stripe-side upgrade can't break us silently. The config is cast to
  // any because the installed SDK build doesn't export the version-string alias types.
  const config = { apiVersion: '2025-02-24.acacia' } as any;
  stripeClient = new Stripe(STRIPE_SECRET_KEY, config);
  return stripeClient;
}

// Configured only when BOTH the key and the recurring price are set, so a half-set env can't
// arm a broken checkout on new signups.
export function stripeConfigured(): boolean {
  return Boolean(STRIPE_SECRET_KEY && STRIPE_ASSIST_PRICE_ID);
}

export interface CreateCheckoutSessionArgs {
  email: string;
  businessName: string;
  // Present for the legacy flow (account already exists). For the new deferred flow the
  // account doesn't exist yet, so pendingSignupId is carried in the metadata instead and
  // the setup_intent.succeeded webhook creates the account from it.
  userId?: string;
  garageId?: string;
  agreementId?: string;
  pendingSignupId?: string;
}

export const STRIPE_TRIAL_DAYS = TRIAL_DAYS;

// Subscription checkout with a 14-day free trial. Card is required (payment_method_collection:
// 'always') but nothing is charged until the trial ends. garageId is carried in BOTH the session
// metadata and the subscription metadata so every downstream webhook can map back to the garage.
export async function createAssistTrialCheckoutSession(args: CreateCheckoutSessionArgs): Promise<Stripe.Checkout.Session> {
  const stripe = getStripeClient();
  if (!STRIPE_ASSIST_PRICE_ID) {
    throw new Error('STRIPE_ASSIST_PRICE_ID is not configured');
  }

  const metadata: Record<string, string> = {
    businessName: args.businessName.slice(0, 100),
    kind: 'assist-trial',
  };
  if (args.userId) metadata.userId = args.userId;
  if (args.garageId) metadata.garageId = args.garageId;
  if (args.agreementId) metadata.agreementId = args.agreementId;
  if (args.pendingSignupId) metadata.pendingSignupId = args.pendingSignupId;

  return stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    customer_email: args.email,
    line_items: [{ price: STRIPE_ASSIST_PRICE_ID, quantity: 1 }],
    // Require a card even though nothing is charged during the trial (card-first).
    payment_method_collection: 'always',
    subscription_data: {
      trial_period_days: TRIAL_DAYS,
      metadata,
    },
    metadata,
    success_url: `${PORTAL_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url:  `${PORTAL_URL}/payment/cancelled?session_id={CHECKOUT_SESSION_ID}`,
  });
}

export interface TrialSubscriptionResult {
  clientSecret: string;   // SetupIntent client_secret — the browser confirms this with the card
  subscriptionId: string;
  customerId: string;
}

// Custom-card-form variant (Stripe Payment Element, no redirect to stripe.com).
//
// A 14-day-trial subscription created with payment_behavior 'default_incomplete' has no payment
// due yet, so Stripe attaches a **SetupIntent** (subscription.pending_setup_intent). The browser
// confirms that SetupIntent with the entered card via the Payment Element; nothing is charged.
// On day 14 Stripe charges the saved card (save_default_payment_method: 'on_subscription'); if no
// card was ever confirmed the trial self-cancels (missing_payment_method: 'cancel').
//
// Provisioning fires from the `setup_intent.succeeded` webhook, which maps back to the garage by
// Stripe customer id — the caller stores that link (garage.stripeCustomerId) right after this
// returns, so we don't need Setup-Intents-write permission to stamp the intent here.
export async function createAssistTrialSubscription(args: CreateCheckoutSessionArgs): Promise<TrialSubscriptionResult> {
  const stripe = getStripeClient();
  if (!STRIPE_ASSIST_PRICE_ID) {
    throw new Error('STRIPE_ASSIST_PRICE_ID is not configured');
  }

  const metadata: Record<string, string> = {
    businessName: args.businessName.slice(0, 100),
    kind: 'assist-trial',
  };
  if (args.userId) metadata.userId = args.userId;
  if (args.garageId) metadata.garageId = args.garageId;
  if (args.agreementId) metadata.agreementId = args.agreementId;
  if (args.pendingSignupId) metadata.pendingSignupId = args.pendingSignupId;

  const customer = await stripe.customers.create({
    email: args.email,
    name: args.businessName.slice(0, 100),
    metadata,
  });

  const subscription = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: STRIPE_ASSIST_PRICE_ID }],
    trial_period_days: TRIAL_DAYS,
    payment_behavior: 'default_incomplete',
    payment_settings: { save_default_payment_method: 'on_subscription' },
    trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
    expand: ['pending_setup_intent'],
    metadata,
  });

  const si = subscription.pending_setup_intent;
  if (!si || typeof si === 'string' || !si.client_secret) {
    throw new Error('Trial subscription produced no SetupIntent client_secret');
  }

  return { clientSecret: si.client_secret, subscriptionId: subscription.id, customerId: customer.id };
}
