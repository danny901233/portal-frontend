'use client';

interface WizardStep10CompleteProps {
  twilioNumber: string | null;
  onComplete: () => void;
  onPrevious: () => void;
  isCompleting: boolean;
}

export default function WizardStep10Complete({
  twilioNumber,
  onComplete,
  onPrevious,
  isCompleting,
}: WizardStep10CompleteProps) {
  return (
    <div className="space-y-6">
      {/* Heading */}
      <div className="text-center">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/10">
          <svg className="h-8 w-8 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
        </div>
        <h2 className="text-3xl font-bold text-slate-100">You're Ready to Go Live!</h2>
        <p className="mt-4 text-lg text-slate-300">
          Your AI assistant is configured and ready to start answering calls.
        </p>
      </div>

      {/* ReceptionMate Number */}
      {twilioNumber ? (
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-6">
          <h3 className="text-lg font-semibold text-slate-200">Your ReceptionMate Phone Number</h3>
          <div className="mt-4 flex items-center justify-between rounded-lg border border-blue-500/30 bg-blue-500/5 p-4">
            <div>
              <p className="text-sm text-slate-400">Forward your calls to:</p>
              <p className="mt-1 text-2xl font-bold text-blue-400">{twilioNumber}</p>
            </div>
            <button
              onClick={() => navigator.clipboard.writeText(twilioNumber)}
              className="rounded-lg bg-slate-800 p-2 text-slate-300 transition-colors hover:bg-slate-700"
              title="Copy number"
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                />
              </svg>
            </button>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-6">
          <div className="flex gap-3">
            <svg
              className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
            <div>
              <h3 className="font-semibold text-amber-300">Phone Number Not Yet Assigned</h3>
              <p className="mt-1 text-sm text-amber-400">
                Your ReceptionMate phone number will be assigned shortly. You'll receive an email with instructions on how to forward your calls.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Instructions */}
      <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-6">
        <h3 className="text-lg font-semibold text-slate-200">Next Steps</h3>
        <ol className="mt-4 space-y-3 text-slate-300">
          <li className="flex items-start gap-3">
            <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-blue-600 text-xs font-bold text-white">
              1
            </span>
            <span>
              Set up call forwarding on your main phone line to forward unanswered calls to your ReceptionMate number after 5-7 rings.
            </span>
          </li>
          <li className="flex items-start gap-3">
            <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-blue-600 text-xs font-bold text-white">
              2
            </span>
            <span>
              Test your setup by calling your main number and letting it ring through to ReceptionMate.
            </span>
          </li>
          <li className="flex items-start gap-3">
            <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-blue-600 text-xs font-bold text-white">
              3
            </span>
            <span>
              Monitor calls in the portal and receive notifications when customers leave messages or book appointments.
            </span>
          </li>
        </ol>
      </div>

      {/* Info Box */}
      <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 p-4">
        <div className="flex gap-3">
          <svg
            className="mt-0.5 h-5 w-5 flex-shrink-0 text-blue-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <p className="text-sm text-blue-300">
            Need help setting up call forwarding? Contact our support team at hello@receptionmate.co.uk
          </p>
        </div>
      </div>

      {/* Buttons */}
      <div className="flex justify-between pt-4">
        <button
          onClick={onPrevious}
          disabled={isCompleting}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-6 py-3 text-sm font-medium text-slate-300 transition-colors hover:bg-slate-700 disabled:opacity-50"
        >
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Previous
        </button>
        <button
          onClick={onComplete}
          disabled={isCompleting}
          className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-emerald-700 disabled:opacity-50"
        >
          {isCompleting && (
            <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              />
            </svg>
          )}
          {isCompleting ? 'Completing Setup...' : 'Complete Setup'}
        </button>
      </div>
    </div>
  );
}
