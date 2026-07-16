'use client';

/**
 * Full-screen payment blocker shown when the selected garage is locked.
 *   - variant 'arrears' (default): existing Assist/voice non-payment lockout — contact support.
 *   - variant 'trial-ended': Connect free month ended with no card — self-serve "Add payment
 *     details" button opens Stripe Checkout (via onAddCard). £250 + VAT/mo incl. 500 credits.
 */
export default function PaymentBlocker({
  garageName,
  onLogout,
  variant = 'arrears',
  onAddCard,
  busy = false,
}: {
  garageName?: string | null;
  onLogout: () => void;
  variant?: 'arrears' | 'trial-ended';
  onAddCard?: () => void;
  busy?: boolean;
}) {
  const trial = variant === 'trial-ended';

  return (
    <div className="fixed inset-0 z-[100] flex min-h-screen items-center justify-center bg-[#09203c] p-6">
      <div className="w-full max-w-lg overflow-hidden rounded-2xl bg-[#1a3a52] shadow-2xl">
        <div className={`px-8 py-8 text-center ${trial ? 'bg-gradient-to-br from-brand-500 to-brand-700' : 'bg-gradient-to-br from-amber-500 to-amber-600'}`}>
          <div className="mb-2 text-4xl">{trial ? '✨' : '🔒'}</div>
          <h1 className="text-2xl font-semibold text-white">
            {trial ? 'Your free month has ended' : 'Your account is in arrears'}
          </h1>
          {garageName ? <p className="mt-1 text-sm text-white/90">{garageName}</p> : null}
        </div>

        <div className="space-y-5 px-8 py-8 text-slate-200">
          {trial ? (
            <>
              <p className="text-base leading-relaxed">
                Your ReceptionMate Connect free month is over, so your AI has paused. Add a card to
                switch it straight back on and keep messaging your customers on WhatsApp.
              </p>
              <div className="rounded-lg border border-[#1e4a66] bg-[#0d2739] p-5 text-sm leading-relaxed text-slate-300">
                <strong className="text-white">£250 + VAT a month</strong>, including 500 conversation
                credits (extra credits 20p each). No contract — cancel anytime.
              </div>
              <div className="flex flex-col gap-3 pt-1 sm:flex-row">
                <button
                  type="button"
                  onClick={onAddCard}
                  disabled={busy}
                  className="flex-1 rounded-lg bg-gradient-to-br from-brand-500 to-brand-600 px-5 py-3 text-center text-sm font-semibold text-white transition hover:from-brand-400 hover:to-brand-500 disabled:opacity-60"
                >
                  {busy ? 'Opening…' : 'Add payment details'}
                </button>
                <button
                  type="button"
                  onClick={onLogout}
                  className="rounded-lg border border-[#1e4a66] px-5 py-3 text-center text-sm font-semibold text-slate-300 transition hover:bg-[#0d2739]"
                >
                  Log out
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="text-base leading-relaxed">
                We weren&apos;t able to take your latest ReceptionMate payment, so access to your
                portal is paused until the account is brought up to date.
              </p>
              <p className="text-base leading-relaxed">
                Don&apos;t worry — your AI receptionist is <strong>still answering your calls</strong>.
                As soon as payment is received, everything unlocks straight away.
              </p>
              <div className="rounded-lg border border-[#1e4a66] bg-[#0d2739] p-5 text-sm leading-relaxed text-slate-300">
                To settle your account or sort out a payment issue, get in touch and we&apos;ll get
                you back up and running:
                <div className="mt-3">
                  <a href="mailto:hello@receptionmate.co.uk?subject=Bring%20my%20account%20up%20to%20date" className="font-semibold text-blue-400 hover:text-blue-300">
                    hello@receptionmate.co.uk
                  </a>
                </div>
              </div>
              <div className="flex flex-col gap-3 pt-1 sm:flex-row">
                <a href="mailto:hello@receptionmate.co.uk?subject=Bring%20my%20account%20up%20to%20date" className="flex-1 rounded-lg bg-gradient-to-br from-amber-500 to-amber-600 px-5 py-3 text-center text-sm font-semibold text-white transition hover:from-amber-400 hover:to-amber-500">
                  Bring my account up to date
                </a>
                <button type="button" onClick={onLogout} className="rounded-lg border border-[#1e4a66] px-5 py-3 text-center text-sm font-semibold text-slate-300 transition hover:bg-[#0d2739]">
                  Log out
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
