'use client';

// Card capture for an EXISTING customer — the one who signs in and has no card on file yet.
//
// TrialCardForm covers the signup path: it carries a password-reset token, a pending-signup id
// and conversion tracking, and it sends people on to choose a password. None of that applies to a
// garage that already has an account, which is why this is separate rather than another set of
// optional props on that one.
//
// Assist and Connect bill by card; Automate bills by Direct Debit. /setup-payment decides which of
// the two to show — this component is only ever mounted for the card half.

import { useEffect, useState } from 'react';
import api from '../lib/api';
import { loadStripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? '');

function Inner({ onDone }: { onDone: () => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stripe || !elements) return;
    setSubmitting(true);
    setError(null);
    // No redirect: staying on the page means someone who mistypes a card number is still signed
    // in and can simply try again.
    const { error: err } = await stripe.confirmSetup({
      elements,
      redirect: 'if_required',
      confirmParams: { return_url: `${window.location.origin}/setup-payment/callback` },
    });
    if (err) {
      setError(err.message ?? 'That card could not be saved. Please check the details and try again.');
      setSubmitting(false);
      return;
    }
    onDone();
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <PaymentElement />
      {error && (
        <p className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>
      )}
      <button
        type="submit"
        disabled={!stripe || submitting}
        className="w-full rounded-lg bg-brand-600 px-4 py-3 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
      >
        {submitting ? 'Saving your card…' : 'Save my card'}
      </button>
      <p className="text-center text-xs text-slate-500">
        Nothing is charged today. Your card is only used when your trial ends.
      </p>
    </form>
  );
}

export default function CardSetupForm({ onDone }: { onDone: () => void }) {
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        // The shared client attaches the auth token. Reading localStorage directly here used the
        // wrong key ('token' rather than 'rm_token') and the request arrived unauthenticated.
        const { data } = await api.post('/api/payment/card-setup-intent');
        if (!live) return;
        if (!data?.clientSecret) {
          setFailed('Could not start card setup.');
          return;
        }
        setClientSecret(data.clientSecret);
      } catch {
        if (live) setFailed('Could not reach the server. Please try again.');
      }
    })();
    return () => { live = false; };
  }, []);

  if (failed) {
    return (
      <p className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700">
        {failed} If it keeps happening, email hello@receptionmate.co.uk and we&apos;ll sort it.
      </p>
    );
  }
  if (!clientSecret) {
    return <p className="text-sm text-slate-500">Getting the payment form ready…</p>;
  }
  return (
    <Elements stripe={stripePromise} options={{ clientSecret, appearance: { theme: 'stripe' } }}>
      <Inner onDone={onDone} />
    </Elements>
  );
}
