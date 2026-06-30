'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { confirmMandateUpdate } from '../../lib/billing';

export default function UpdatePaymentCallback() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<'processing' | 'success' | 'error'>('processing');
  const [message, setMessage] = useState('Confirming payment method update...');

  useEffect(() => {
    const redirectFlowId = searchParams?.get('redirect_flow_id');

    if (!redirectFlowId) {
      setStatus('error');
      setMessage('Missing flow information. Please try again.');
      return;
    }

    async function confirmUpdate() {
      try {
        await confirmMandateUpdate(redirectFlowId!);
        setStatus('success');
        setMessage('Payment method updated successfully!');

        // Redirect to billing page after 2 seconds
        setTimeout(() => {
          router.push('/billing');
        }, 2000);
      } catch (error) {
        console.error('Failed to confirm mandate update:', error);
        setStatus('error');
        setMessage('Failed to update payment method. Please try again or contact support.');
      }
    }

    void confirmUpdate();
  }, [searchParams, router]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-white p-6">
      <div className="w-full max-w-md space-y-6 rounded-2xl border border-slate-200 bg-white p-8 text-center">
        {status === 'processing' && (
          <>
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-blue-500/10">
              <svg className="h-8 w-8 animate-spin text-blue-400" fill="none" viewBox="0 0 24 24">
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
            </div>
            <h1 className="text-2xl font-bold text-slate-900">Processing</h1>
          </>
        )}

        {status === 'success' && (
          <>
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-50">
              <svg className="h-8 w-8 text-emerald-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
            </div>
            <h1 className="text-2xl font-bold text-slate-900">Success!</h1>
          </>
        )}

        {status === 'error' && (
          <>
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-red-500/10">
              <svg className="h-8 w-8 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </div>
            <h1 className="text-2xl font-bold text-slate-900">Error</h1>
          </>
        )}

        <p className="text-slate-500">{message}</p>

        {status === 'error' && (
          <button
            onClick={() => router.push('/billing')}
            className="w-full rounded-lg bg-blue-600 px-4 py-2 font-medium text-white transition-colors hover:bg-blue-700"
          >
            Return to Billing
          </button>
        )}

        {status === 'success' && (
          <p className="text-sm text-slate-500">Redirecting to billing page...</p>
        )}
      </div>
    </div>
  );
}
