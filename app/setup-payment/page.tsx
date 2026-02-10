'use client';

import { useMutation } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState, useEffect, Suspense } from 'react';
import { TOKEN_STORAGE_KEY } from '../lib/auth';

function SetupPaymentContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [isVerifyingToken, setIsVerifyingToken] = useState(false);

  // Check for magic link token on mount
  useEffect(() => {
    const token = searchParams?.get('token');
    if (token && !localStorage.getItem(TOKEN_STORAGE_KEY)) {
      verifyMagicLinkToken(token);
    }
  }, [searchParams]);

  const verifyMagicLinkToken = async (magicToken: string) => {
    setIsVerifyingToken(true);
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:4000';
      const response = await fetch(`${apiUrl}/api/auth/verify-magic-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: magicToken }),
      });

      if (!response.ok) {
        throw new Error('Invalid or expired link. Please request a new one.');
      }

      const data = await response.json();
      // Store the auth token
      localStorage.setItem(TOKEN_STORAGE_KEY, data.token);
      setError(null);
    } catch (err: any) {
      setError(err.message || 'Failed to verify link');
    } finally {
      setIsVerifyingToken(false);
    }
  };

  const createMandateMutation = useMutation({
    mutationFn: async () => {
      const token = localStorage.getItem(TOKEN_STORAGE_KEY);
      if (!token) {
        throw new Error('Not authenticated');
      }

      const apiUrl = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:4000';
      const response = await fetch(`${apiUrl}/api/payment/create-mandate-flow`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to initiate payment setup');
      }

      return response.json();
    },
    onSuccess: (data: { redirectUrl: string; redirectFlowId: string }) => {
      // Store the redirect flow ID for later confirmation
      sessionStorage.setItem('gocardless_redirect_flow_id', data.redirectFlowId);
      // Redirect to GoCardless hosted page
      window.location.href = data.redirectUrl;
    },
    onError: (error: Error) => {
      setError(error.message || 'Failed to set up payment. Please try again.');
    },
  });

  const handleSetupPayment = () => {
    setError(null);
    createMandateMutation.mutate();
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 px-4 text-slate-100">
      <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900/60 p-8 shadow-2xl shadow-slate-900/40">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-6 flex justify-center">
            <img
              src="https://storage.googleapis.com/msgsndr/2UadumwHCXxeU9yxBIRC/media/65cf28be6e4392e608cca8a9.png"
              alt="ReceptionMate Logo"
              className="h-24 w-auto"
            />
          </div>
          <h1 className="text-2xl font-semibold">Set Up Direct Debit</h1>
          <p className="mt-2 text-sm text-slate-400">
            Complete your account setup by setting up your monthly subscription payment
          </p>
        </div>

        <div className="space-y-6">
          <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-4">
            <h2 className="text-sm font-semibold text-slate-200 mb-2">What you need to know:</h2>
            <ul className="space-y-2 text-sm text-slate-400">
              <li className="flex items-start">
                <span className="mr-2 text-sky-400">•</span>
                <span>Secure Direct Debit payment via GoCardless</span>
              </li>
              <li className="flex items-start">
                <span className="mr-2 text-sky-400">•</span>
                <span>Protected by the Direct Debit Guarantee</span>
              </li>
              <li className="flex items-start">
                <span className="mr-2 text-sky-400">•</span>
                <span>You'll be redirected to complete setup</span>
              </li>
              <li className="flex items-start">
                <span className="mr-2 text-sky-400">•</span>
                <span>Takes less than 2 minutes</span>
              </li>
            </ul>
          </div>

          {error && (
            <div className="rounded-lg border border-rose-500/60 bg-rose-500/15 px-4 py-3 text-sm text-rose-200">
              {error}
            </div>
          )}

          <button
            onClick={handleSetupPayment}
            disabled={createMandateMutation.isPending || isVerifyingToken}
            className="w-full rounded-lg bg-sky-500 px-4 py-3 text-sm font-semibold text-white transition-transform hover:bg-sky-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 disabled:cursor-not-allowed disabled:bg-slate-700"
          >
            {isVerifyingToken ? 'Verifying link...' : createMandateMutation.isPending ? 'Setting up...' : 'Set Up Direct Debit'}
          </button>

          <p className="text-center text-xs text-slate-500">
            By continuing, you agree to set up a Direct Debit mandate for your ReceptionMate subscription.
          </p>
        </div>
      </div>
    </div>
  );
}

export default function SetupPaymentPage() {
  return (
    <Suspense fallback={
      <div className="flex min-h-screen items-center justify-center bg-slate-950 px-4 text-slate-100">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-sky-500 mx-auto"></div>
          <p className="mt-4 text-slate-400">Loading...</p>
        </div>
      </div>
    }>
      <SetupPaymentContent />
    </Suspense>
  );
}
