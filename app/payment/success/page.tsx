// Landing page after a successful Stripe Checkout. The webhook does the real
// work (provisions Twilio, sends welcome email) — this page is purely visual.

export default function PaymentSuccessPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-12">
      <div className="w-full max-w-md rounded-3xl border border-emerald-200 bg-white p-8 shadow-sm">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100">
          <svg className="h-6 w-6 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h1 className="mt-5 text-2xl font-bold text-slate-900">Payment received.</h1>
        <p className="mt-2 text-sm text-slate-600">
          You&rsquo;re all set. We&rsquo;ve started setting up your number and we&rsquo;ll
          email your portal login in the next minute or two.
        </p>

        <ol className="mt-6 space-y-3 rounded-2xl bg-slate-50 p-5 text-sm text-slate-700">
          <li className="flex gap-3">
            <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-bold text-brand-700">1</span>
            <span><span className="block font-semibold text-slate-900">Check your email for your login</span><span className="mt-0.5 block text-xs text-slate-600">We&rsquo;re sending your portal username and a temporary password right now.</span></span>
          </li>
          <li className="flex gap-3">
            <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-bold text-brand-700">2</span>
            <span><span className="block font-semibold text-slate-900">Sign in and complete your setup wizard</span><span className="mt-0.5 block text-xs text-slate-600">Pick your voice, branch hours and greetings.</span></span>
          </li>
          <li className="flex gap-3">
            <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-bold text-brand-700">3</span>
            <span><span className="block font-semibold text-slate-900">Set up Direct Debit for future months</span><span className="mt-0.5 block text-xs text-slate-600">Today&rsquo;s payment covers your first month — Direct Debit takes over from month two.</span></span>
          </li>
        </ol>

        <a
          href="/login"
          className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-brand-600 px-5 py-3 text-sm font-semibold text-white shadow-md shadow-brand-600/30 hover:bg-brand-700 transition"
        >
          Open the portal
          <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M3 10a.75.75 0 01.75-.75h10.638L10.23 5.29a.75.75 0 111.04-1.08l5.5 5.25a.75.75 0 010 1.08l-5.5 5.25a.75.75 0 11-1.04-1.08l4.158-3.96H3.75A.75.75 0 013 10z" clipRule="evenodd"/></svg>
        </a>
        <p className="mt-3 text-center text-xs text-slate-500">
          No login email after a minute? Check spam, or write to{' '}
          <a href="mailto:hello@receptionmate.co.uk" className="underline">hello@receptionmate.co.uk</a>.
        </p>
      </div>
    </div>
  );
}
