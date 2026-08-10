'use client';

// Landing page for the 3-D Secure redirect from the Assist trial card form. Most cards confirm
// inline (no redirect) and never reach here; when the bank forces SCA, Stripe returns the customer
// to this URL with ?redirect_status=… . Provisioning is webhook-driven, so this page just reports
// the outcome and points them at the portal.

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';

function Inner() {
  const params = useSearchParams();
  const status = params.get('redirect_status');
  const failed = status === 'failed';

  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-4 py-12">
      <div className="rounded-3xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        {failed ? (
          <>
            <h1 className="text-xl font-semibold text-slate-900">We couldn’t confirm your card</h1>
            <p className="mt-2 text-sm text-slate-600">
              Your bank didn’t authorise the card. Nothing has been charged. Please head back and try again,
              or use a different card.
            </p>
          </>
        ) : (
          <>
            <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-emerald-100">
              <svg className="h-6 w-6 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h1 className="mt-3 text-xl font-semibold text-slate-900">You’re all set.</h1>
            <p className="mt-2 text-sm text-slate-600">
              Your 14-day free trial has started — no charge today. We’re setting your number up now and your
              login is on its way by email.
            </p>
          </>
        )}
        <a
          href="/login"
          className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-brand-600 px-5 py-3 text-sm font-semibold text-white shadow-md shadow-brand-600/30 hover:bg-brand-700 transition"
        >
          Open the portal
        </a>
      </div>
    </main>
  );
}

export default function StripeCompletePage() {
  return (
    <Suspense fallback={null}>
      <Inner />
    </Suspense>
  );
}
