'use client';

import { useState } from 'react';
import type { MandateStatus } from '../../lib/billing';
import { createMandateUpdateFlow } from '../../lib/billing';

interface MandateStatusCardProps {
  mandateStatus: MandateStatus;
}

export default function MandateStatusCard({ mandateStatus }: MandateStatusCardProps) {
  const [isUpdating, setIsUpdating] = useState(false);

  const handleUpdateMandate = async () => {
    setIsUpdating(true);
    try {
      const { redirectUrl } = await createMandateUpdateFlow();
      window.location.href = redirectUrl;
    } catch (error) {
      console.error('Failed to create mandate update flow:', error);
      alert('Failed to initiate payment method update. Please try again.');
      setIsUpdating(false);
    }
  };

  const formatDate = (dateString: string | null) => {
    if (!dateString) return 'N/A';
    return new Date(dateString).toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'long',
      year: 'numeric',
    });
  };

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">Direct Debit</h2>
          <p className="mt-1 text-sm text-slate-500">
            Your payment method and billing schedule
          </p>
        </div>
        {mandateStatus.hasMandate && (
          <button
            onClick={handleUpdateMandate}
            disabled={isUpdating}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {isUpdating && (
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
            {isUpdating ? 'Redirecting...' : 'Update Payment Method'}
          </button>
        )}
      </div>

      <div className="space-y-4">
        {mandateStatus.hasMandate ? (
          <>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-50">
                <svg className="h-5 w-5 text-emerald-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
              </div>
              <div>
                <div className="font-medium text-slate-700">Direct Debit Active</div>
                <div className="text-sm text-slate-500">Your payment method is set up and active</div>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="rounded-lg border border-slate-200 bg-white p-4">
                <div className="text-xs font-medium uppercase tracking-wider text-slate-500">
                  Status
                </div>
                <div className="mt-1 inline-flex items-center gap-2">
                  <span className="inline-flex h-2 w-2 rounded-full bg-emerald-400"></span>
                  <span className="text-sm capitalize text-slate-600">{mandateStatus.status}</span>
                </div>
              </div>

              <div className="rounded-lg border border-slate-200 bg-white p-4">
                <div className="text-xs font-medium uppercase tracking-wider text-slate-500">
                  Next Billing Date
                </div>
                <div className="mt-1 text-sm text-slate-600">
                  {formatDate(mandateStatus.nextBillingDate)}
                </div>
              </div>

              {mandateStatus.mandateId && (
                <div className="rounded-lg border border-slate-200 bg-white p-4 md:col-span-2">
                  <div className="text-xs font-medium uppercase tracking-wider text-slate-500">
                    Mandate Reference
                  </div>
                  <div className="mt-1 font-mono text-xs text-slate-500">
                    {mandateStatus.mandateId}
                  </div>
                </div>
              )}
            </div>

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
                <div className="text-sm text-blue-300">
                  <p className="font-medium">Automatic Billing</p>
                  <p className="mt-1 text-blue-400">
                    Your subscription and usage charges will be automatically collected via Direct Debit on your billing date.
                  </p>
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-6 text-center">
            <svg
              className="mx-auto h-12 w-12 text-amber-700"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
            <h3 className="mt-4 text-lg font-medium text-amber-300">No Direct Debit Set Up</h3>
            <p className="mt-2 text-sm text-amber-700">
              You need to set up Direct Debit to enable automatic billing.
            </p>
            <a
              href="/setup-payment"
              className="mt-4 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-blue-700"
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 6v6m0 0v6m0-6h6m-6 0H6"
                />
              </svg>
              Set Up Direct Debit
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
