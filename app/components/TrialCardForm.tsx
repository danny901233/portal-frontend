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

function CardForm({ resetToken, pendingSignupId, email }: { resetToken?: string | null; pendingSignupId?: string | null; email?: string | null }) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [succeeded, setSucceeded] = useState(false);

  const chooseUrl = (t: string) => `${window.location.origin}/reset-password?token=${encodeURIComponent(t)}&setup=1`;

  // 3-D Secure return_url (most cards confirm inline and never use this). If we already have a
  // reset token, go straight to Choose-a-password; otherwise the webhook provisions + welcome email.
  const nextUrl = resetToken
    ? chooseUrl(resetToken)
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
      // Card confirmed inline (no 3-D Secure). For the deferred flow, create the account NOW
      // (returns a set-password token), then go to Choose-a-password → auto-login.
      setSucceeded(true);
      // Google Ads conversion — a real, carded 14-day trial has started (Count=One, so Google
      // de-dupes per click even if this ever fires more than once).
      const w = window as unknown as { gtag?: (...args: unknown[]) => void };
      if (typeof w.gtag === 'function') {
        // Enhanced conversions: pass the customer's email (gtag normalises + hashes it before
        // sending) so Google can match the conversion more accurately. Improves attribution only —
        // the email is never exposed back to us.
        if (email) w.gtag('set', 'user_data', { email });
        w.gtag('event', 'conversion', { send_to: 'AW-16449651971/8I8tCMHe7s0cEIOK56M9', value: 200, currency: 'GBP' });
      }
      if (pendingSignupId && !resetToken) {
        try {
          const res = await fetch('/internal-api/public/signup-complete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pendingSignupId }),
          });
          const data = await res.json().catch(() => ({}));
          if (data?.resetToken) {
            window.location.href = chooseUrl(data.resetToken);
            return;
          }
        } catch {
          /* fall through — the webhook is the backstop; they can log in via the welcome email */
        }
      }
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

export default function TrialCardForm({ clientSecret, resetToken, pendingSignupId, email }: { clientSecret: string; resetToken?: string | null; pendingSignupId?: string | null; email?: string | null }) {
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
      <CardForm resetToken={resetToken} pendingSignupId={pendingSignupId} email={email} />
    </Elements>
  );
}
