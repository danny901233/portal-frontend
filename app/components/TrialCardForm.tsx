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

function CardForm({ resetToken }: { resetToken?: string | null }) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [succeeded, setSucceeded] = useState(false);

  // Where to send the customer once the card is confirmed: straight to set their own password
  // (then they log in — no welcome email needed). Same URL doubles as the 3-D Secure return_url.
  const nextUrl = resetToken
    ? `${window.location.origin}/reset-password?token=${encodeURIComponent(resetToken)}&setup=1`
    : `${window.location.origin}/setup-payment/stripe-complete`;

  const handlePay = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stripe || !elements) return;
    setSubmitting(true);
    setError(null);

    const { error: confirmErr, setupIntent } = await stripe.confirmSetup({
      elements,
      confirmParams: {
        // Used if the bank forces a 3-D Secure redirect; most cards confirm inline.
        return_url: nextUrl,
      },
      redirect: 'if_required',
    });

    if (confirmErr) {
      setError(confirmErr.message ?? 'We couldn’t confirm your card. Please try again.');
      setSubmitting(false);
      return;
    }
    if (setupIntent && setupIntent.status === 'succeeded') {
      // Card confirmed inline (no 3-D Secure) — go set a password, then log in.
      setSucceeded(true);
      window.location.href = nextUrl;
      return;
    }
    // A redirect is in progress (3-D Secure) — return_url takes over.
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
        <p className="mt-3 text-sm font-semibold text-emerald-900">Card confirmed — your 14-day free trial has started.</p>
        <p className="mt-1 text-sm text-emerald-700">No charge today. Taking you to set your password…</p>
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

export default function TrialCardForm({ clientSecret, resetToken }: { clientSecret: string; resetToken?: string | null }) {
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
      <CardForm resetToken={resetToken} />
    </Elements>
  );
}
