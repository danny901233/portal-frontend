'use client';

import { useEffect, useState } from 'react';

/**
 * Where Stripe sends the customer after a setup-fee payment.
 *
 * Doubles as the cancel destination: Stripe substitutes {CHECKOUT_SESSION_ID} into both urls, so
 * this page asks the backend what actually happened rather than assuming the redirect means paid
 * (a customer can reach success_url and still have a payment that needs review).
 *
 * Deliberately public and token-free — the session id is the unguessable bit, and the person who
 * just paid may well not have a portal login yet.
 */

type Status = {
  status: 'paid' | 'pending' | 'unknown';
  invoiceNumber: string | null;
  grossPence: number | null;
  clientName: string | null;
  payUrl: string | null;
};

const BANK = [
  ['Account name', 'ReceptionMate Ltd'],
  ['Sort code', '23-01-20'],
  ['Account number', '49981874'],
] as const;

export default function SetupFeePaidPage() {
  const [state, setState] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const sessionId = new URLSearchParams(window.location.search).get('session_id');
    if (!sessionId) {
      setState({ status: 'unknown', invoiceNumber: null, grossPence: null, clientName: null, payUrl: null });
      setLoading(false);
      return;
    }
    // The webhook is what marks the invoice paid, and it can land a beat after the redirect.
    // Poll briefly rather than tell someone who just paid that they haven't.
    let tries = 0;
    const poll = async () => {
      try {
        const r = await fetch(`/internal-api/agreements/setup-fee/status?session_id=${encodeURIComponent(sessionId)}`);
        const d: Status = await r.json();
        setState(d);
        if (d.status !== 'paid' && tries < 4) {
          tries += 1;
          setTimeout(poll, 1500);
          return;
        }
      } catch {
        setState({ status: 'unknown', invoiceNumber: null, grossPence: null, clientName: null, payUrl: null });
      }
      setLoading(false);
    };
    void poll();
  }, []);

  const money = (p: number | null) =>
    p == null ? '' : `£${(p / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <div className="min-h-screen bg-slate-50 py-10">
      <div className="mx-auto w-full max-w-3xl px-4">
        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
          {loading ? (
            <p className="text-sm text-slate-500">Checking your payment…</p>
          ) : state?.status === 'paid' ? (
            <>
              <div className="flex items-start gap-4">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-100">
                  <svg className="h-5 w-5 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <div className="min-w-0 flex-1">
                  <h1 className="text-xl font-semibold text-slate-900">Payment received — thank you</h1>
                  <p className="mt-1 text-sm text-slate-600">
                    {state.grossPence ? `${money(state.grossPence)} paid` : 'Your setup fee is paid'}
                    {state.invoiceNumber ? ` · invoice ${state.invoiceNumber}` : ''}. A receipt is on its way to your inbox.
                  </p>
                </div>
              </div>

              <div className="mt-6 rounded-2xl bg-slate-50 p-5">
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">What happens next</p>
                <ol className="mt-3 space-y-3 text-sm text-slate-700">
                  <Step n={1} title="We build your agent" body="We'll set up your integration and get your AI receptionist ready — nothing needed from you." />
                  <Step n={2} title="Check your email for your login" body="As soon as your agent is ready we'll email your username and a temporary password." />
                  <Step n={3} title="Sign in and complete your setup" body="Set your own password, then pick your voice, hours and greetings." />
                  <Step n={4} title="Set up your Direct Debit" body="Takes 30 seconds — we'll bill on the day you go live." />
                </ol>
              </div>

              <p className="mt-4 text-center text-xs text-slate-500">
                Questions? <a href="mailto:hello@receptionmate.co.uk" className="underline">hello@receptionmate.co.uk</a>
              </p>
            </>
          ) : (
            <>
              <h1 className="text-xl font-semibold text-slate-900">Your setup fee isn&apos;t paid yet</h1>
              <p className="mt-1 text-sm text-slate-600">
                No payment was taken{state?.invoiceNumber ? ` for invoice ${state.invoiceNumber}` : ''}. You can try
                again by card, or pay by bank transfer — whichever suits.
              </p>

              {state?.payUrl ? (
                <a
                  href={state.payUrl}
                  className="mt-5 inline-flex w-full items-center justify-center rounded-2xl bg-brand-600 px-5 py-3 text-sm font-semibold text-white shadow-md shadow-brand-600/30 transition hover:bg-brand-700"
                >
                  Try again by card{state.grossPence ? ` — ${money(state.grossPence)}` : ''}
                </a>
              ) : null}

              <div className="mt-5 rounded-2xl bg-slate-50 p-5">
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Pay by bank transfer</p>
                <dl className="mt-2 space-y-1 text-sm">
                  {BANK.map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-3">
                      <dt className="text-slate-500">{k}</dt>
                      <dd className="font-medium text-slate-900">{v}</dd>
                    </div>
                  ))}
                  {state?.invoiceNumber ? (
                    <div className="flex justify-between gap-3">
                      <dt className="text-slate-500">Reference</dt>
                      <dd className="font-medium text-slate-900">{state.invoiceNumber}</dd>
                    </div>
                  ) : null}
                </dl>
              </div>

              <p className="mt-4 text-sm text-slate-600">
                Your agreement is signed either way — we&apos;re already getting your integration set up, and we&apos;ll
                email your login details when your agent is ready.
              </p>
              <p className="mt-4 text-center text-xs text-slate-500">
                Already paid, or something looks wrong?{' '}
                <a href="mailto:hello@receptionmate.co.uk" className="underline">hello@receptionmate.co.uk</a>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Step({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <li className="flex gap-3">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-700">
        {n}
      </span>
      <span>
        <span className="font-medium text-slate-900">{title}</span>
        <br />
        <span className="text-slate-600">{body}</span>
      </span>
    </li>
  );
}
