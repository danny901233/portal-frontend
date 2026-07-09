'use client';

/**
 * Full-screen payment blocker shown when the selected garage is locked for non-payment
 * (arrears). Replaces the whole portal — the user can't do anything except contact us or
 * log out — while their AI receptionist keeps answering calls in the background.
 */
export default function PaymentBlocker({
  garageName,
  onLogout,
}: {
  garageName?: string | null;
  onLogout: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[100] flex min-h-screen items-center justify-center bg-[#09203c] p-6">
      <div className="w-full max-w-lg overflow-hidden rounded-2xl bg-[#1a3a52] shadow-2xl">
        <div className="bg-gradient-to-br from-amber-500 to-amber-600 px-8 py-8 text-center">
          <div className="mb-2 text-4xl">🔒</div>
          <h1 className="text-2xl font-semibold text-white">Your account is in arrears</h1>
          {garageName ? (
            <p className="mt-1 text-sm text-white/90">{garageName}</p>
          ) : null}
        </div>

        <div className="space-y-5 px-8 py-8 text-slate-200">
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
              <a
                href="mailto:hello@receptionmate.co.uk?subject=Bring%20my%20account%20up%20to%20date"
                className="font-semibold text-blue-400 hover:text-blue-300"
              >
                hello@receptionmate.co.uk
              </a>
            </div>
          </div>

          <div className="flex flex-col gap-3 pt-1 sm:flex-row">
            <a
              href="mailto:hello@receptionmate.co.uk?subject=Bring%20my%20account%20up%20to%20date"
              className="flex-1 rounded-lg bg-gradient-to-br from-amber-500 to-amber-600 px-5 py-3 text-center text-sm font-semibold text-white transition hover:from-amber-400 hover:to-amber-500"
            >
              Bring my account up to date
            </a>
            <button
              type="button"
              onClick={onLogout}
              className="rounded-lg border border-[#1e4a66] px-5 py-3 text-center text-sm font-semibold text-slate-300 transition hover:bg-[#0d2739]"
            >
              Log out
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
