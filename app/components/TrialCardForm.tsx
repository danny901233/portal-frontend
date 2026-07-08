'use client';

// Custom card form for the Assist 14-day free trial — Stripe Payment Element, no redirect to
// stripe.com. The backend creates a trial subscription and hands us its SetupIntent client_secret;
// we collect the card here and confirm it. Nothing is charged today (trial); Stripe charges the
// saved card on day 14. Provisioning happens server-side from the setup_intent.succeeded webhook.

import { useState } from 'react';
import { loadStripe } from '@stripe/stripe-js';
import {
  Elements,
  PaymentElement,
  useStripe,
  useElements,
} from '@stripe/react-stripe-js';

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? '');

function CardForm() {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [succeeded, setSucceeded] = useState(false);

  const handlePay = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stripe || !elements) return;
    setSubmitting(true);
    setError(null);

    const { error: confirmErr, setupIntent } = await stripe.confirmSetup({
      elements,
      confirmParams: {
        // Only used if the bank forces a 3-D Secure redirect; most cards confirm inline.
        return_url: `${window.location.origin}/setup-payment/stripe-complete`,
      },
      redirect: 'if_required',
    });

    if (confirmErr) {
      setError(confirmErr.message ?? 'We couldn’t confirm your card. Please try again.');
      setSubmitting(false);
      return;
    }
    if (setupIntent && setupIntent.status === 'succeeded') {
      setSucceeded(true);
      return;
    }
    // A redirect is in progress (3-D Secure) — the return page takes over.
    setSubmitting(false);
  };

  if (succeeded) {
    return (
      <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5 text-center">
        <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-emerald-100">
          <svg className="h-5 w-5 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <p className="mt-3 text-sm font-semibold text-emerald-900">You’re all set — your 14-day free trial has started.</p>
        <p className="mt-1 text-sm text-emerald-700">
          No charge today. We’re setting your number up now and your login is on its way by email.
        </p>
        <a
          href="/login"
          className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-brand-600 px-5 py-3 text-sm font-semibold text-white shadow-md shadow-brand-600/30 hover:bg-brand-700 transition"
        >
          Open the portal
          <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M3 10a.75.75 0 01.75-.75h10.638L10.23 5.29a.75.75 0 111.04-1.08l5.5 5.25a.75.75 0 010 1.08l-5.5 5.25a.75.75 0 11-1.04-1.08l4.158-3.96H3.75A.75.75 0 013 10z" clipRule="evenodd"/></svg>
        </a>
      </div>
    );
  }

  return (
    <form onSubmit={handlePay} className="space-y-4">
      <PaymentElement options={{ layout: 'tabs' }} />
      {error ? <p className="text-sm text-rose-600">{error}</p> : null}
      <button
        type="submit"
        disabled={!stripe || submitting}
        className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-brand-600 px-5 py-3 text-sm font-semibold text-white shadow-md shadow-brand-600/30 transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {submitting ? 'Confirming…' : 'Start my free trial'}
      </button>
      <p className="text-center text-xs text-slate-500">
        14-day free trial — you won’t be charged today. £200 + VAT / month after, cancel anytime.
      </p>
    </form>
  );
}

export default function TrialCardForm({ clientSecret }: { clientSecret: string }) {
  return (
    <Elements
      stripe={stripePromise}
      options={{
        clientSecret,
        appearance: {
          theme: 'stripe',
          variables: {
            colorPrimary: '#4f46e5',
            borderRadius: '12px',
            fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif',
          },
        },
      }}
    >
      <CardForm />
    </Elements>
  );
}
