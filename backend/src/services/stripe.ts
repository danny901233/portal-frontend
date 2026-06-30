// Stripe Checkout helper. We use Stripe ONLY for the first month's payment
// (card) on new public-signup customers; ongoing monthly subscriptions are
// charged via GoCardless Direct Debit (the existing billing infrastructure).
//
// The reason for the split:
//   • Card payment lets us validate the customer is real before we spend
//     money on Twilio numbers + SIP provisioning. No more eaten costs on
//     bad signups.
//   • Direct Debit is cheaper for recurring monthly charges (~£1 cap vs
//     ~1.5-2% per card transaction).
//
// Flow:
//   1. Customer signs agreement → backend creates Checkout session, returns URL
//   2. Customer pays on Stripe Checkout
//   3. Stripe webhook fires `checkout.session.completed` → we provision
//      Twilio + send welcome email + create paid invoice
//   4. On first login, customer is prompted to set up GoCardless for next
//      month onwards.

import Stripe from 'stripe';

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? '';
const STRIPE_PRICE_GBP  = 200;
const STRIPE_VAT_RATE   = 0.2;
const PORTAL_URL = (process.env.PORTAL_URL || 'https://portal.receptionmate.co.uk').replace(/\/$/, '');

let stripeClient: Stripe | null = null;

export function getStripeClient(): Stripe {
  if (!STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is not configured');
  }
  if (stripeClient) return stripeClient;
  stripeClient = new Stripe(STRIPE_SECRET_KEY, {
    // Pin the API version so a Stripe-side upgrade can't break us silently.
    apiVersion: '2025-02-24.acacia' as Stripe.LatestApiVersion,
  });
  return stripeClient;
}

export function stripeConfigured(): boolean {
  return Boolean(STRIPE_SECRET_KEY);
}

export interface CreateCheckoutSessionArgs {
  userId: string;
  email: string;
  businessName: string;
  garageId: string;
  agreementId: string;
}

// Total charged = £200 subscription + 20% VAT = £240. Stripe takes amounts
// in the smallest currency unit (pence), so 24000.
const TOTAL_PENCE = Math.round((STRIPE_PRICE_GBP + STRIPE_PRICE_GBP * STRIPE_VAT_RATE) * 100);

export async function createFirstMonthCheckoutSession(args: CreateCheckoutSessionArgs): Promise<Stripe.Checkout.Session> {
  const stripe = getStripeClient();

  return stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    customer_email: args.email,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'gbp',
          unit_amount: TOTAL_PENCE,
          product_data: {
            name: 'ReceptionMate Assist — first month',
            description: `${args.businessName} · 400 minutes included · 20% VAT included`,
          },
        },
      },
    ],
    // We attach all the IDs we need to provision the account on the webhook
    // side. Keep this lean — Stripe metadata values are capped at 500 chars.
    metadata: {
      userId:      args.userId,
      garageId:    args.garageId,
      agreementId: args.agreementId,
      businessName: args.businessName.slice(0, 100),
      kind: 'first-month-assist',
    },
    success_url: `${PORTAL_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url:  `${PORTAL_URL}/payment/cancelled?session_id={CHECKOUT_SESSION_ID}`,
  });
}

export const STRIPE_FIRST_MONTH_TOTAL_GBP = STRIPE_PRICE_GBP + STRIPE_PRICE_GBP * STRIPE_VAT_RATE;
export const STRIPE_FIRST_MONTH_TOTAL_PENCE = TOTAL_PENCE;
