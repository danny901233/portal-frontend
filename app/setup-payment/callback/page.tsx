'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, Suspense } from 'react';
import { useMutation } from '@tanstack/react-query';
import { TOKEN_STORAGE_KEY, getGarageId } from '../../lib/auth';

function CallbackContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<'processing' | 'success' | 'error'>('processing');
  const [errorMessage, setErrorMessage] = useState<string>('');

  const confirmMandateMutation = useMutation({
    mutationFn: async (redirectFlowId: string) => {
      const token = localStorage.getItem(TOKEN_STORAGE_KEY);
      if (!token) {
        throw new Error('Not authenticated');
      }

      const apiUrl = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:4000';
      const response = await fetch(`${apiUrl}/api/payment/confirm-mandate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ redirectFlowId }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to confirm payment setup');
      }

      return response.json();
    },
    onSuccess: () => {
      setStatus('success');
      sessionStorage.removeItem('gocardless_redirect_flow_id');
      // Redirect to calls page after a short delay
      setTimeout(() => {
        router.push('/calls');
      }, 2000);
    },
    onError: (error: Error) => {
      setStatus('error');
      setErrorMessage(error.message || 'Failed to confirm payment setup');
    },
  });

  useEffect(() => {
    const redirectFlowId = searchParams.get('redirect_flow_id');
    const storedFlowId = sessionStorage.getItem('gocardless_redirect_flow_id');

    // Check if user cancelled
    if (searchParams.get('cancelled') === 'true') {
      setStatus('error');
      setErrorMessage('Payment setup was cancelled. Please try again.');
      return;
    }

    // Validate we have a redirect flow ID
    if (!redirectFlowId) {
      setStatus('error');
      setErrorMessage('Invalid callback - missing redirect flow ID');
      return;
    }

    // Confirm the mandate with the backend
    confirmMandateMutation.mutate(redirectFlowId);
  }, [searchParams]);

  if (status === 'processing') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 px-4 text-slate-100">
        <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900/60 p-8 shadow-2xl shadow-slate-900/40">
          <div className="text-center">
            <div className="mx-auto mb-6 flex justify-center">
              <img
                src="https://storage.googleapis.com/msgsndr/2UadumwHCXxeU9yxBIRC/media/65cf28be6e4392e608cca8a9.png"
                alt="ReceptionMate Logo"
                className="h-24 w-auto"
              />
            </div>
            <div className="mb-4 flex justify-center">
              <div className="h-12 w-12 animate-spin rounded-full border-4 border-slate-700 border-t-sky-500"></div>
            </div>
            <h1 className="text-2xl font-semibold">Processing Payment Setup</h1>
            <p className="mt-2 text-sm text-slate-400">
              Please wait while we confirm your Direct Debit mandate...
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (status === 'success') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 px-4 text-slate-100">
        <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900/60 p-8 shadow-2xl shadow-slate-900/40">
          <div className="text-center">
            <div className="mx-auto mb-6 flex justify-center">
              <img
                src="https://storage.googleapis.com/msgsndr/2UadumwHCXxeU9yxBIRC/media/65cf28be6e4392e608cca8a9.png"
                alt="ReceptionMate Logo"
                className="h-24 w-auto"
              />
            </div>
            <div className="mb-4 flex justify-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/20">
                <svg
                  className="h-8 w-8 text-emerald-400"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
              </div>
            </div>
            <h1 className="text-2xl font-semibold">Payment Setup Complete!</h1>
            <p className="mt-2 text-sm text-slate-400">
              Your Direct Debit has been set up successfully. Redirecting to your dashboard...
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Error state
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 px-4 text-slate-100">
      <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900/60 p-8 shadow-2xl shadow-slate-900/40">
        <div className="text-center">
          <div className="mx-auto mb-6 flex justify-center">
            <img
              src="https://storage.googleapis.com/msgsndr/2UadumwHCXxeU9yxBIRC/media/65cf28be6e4392e608cca8a9.png"
              alt="ReceptionMate Logo"
              className="h-24 w-auto"
            />
          </div>
          <div className="mb-4 flex justify-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-rose-500/20">
              <svg
                className="h-8 w-8 text-rose-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </div>
          </div>
          <h1 className="text-2xl font-semibold">Payment Setup Failed</h1>
          <p className="mt-2 text-sm text-slate-400">{errorMessage}</p>
          <button
            onClick={() => router.push('/setup-payment')}
            className="mt-6 w-full rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-white transition-transform hover:bg-sky-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
          >
            Try Again
          </button>
        </div>
      </div>
    </div>
  );
}

export default function CallbackPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-100">
          <div className="text-slate-400">Loading...</div>
        </div>
      }
    >
      <CallbackContent />
    </Suspense>
  );
}
