'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, Suspense } from 'react';
import { useMutation } from '@tanstack/react-query';
import { TOKEN_STORAGE_KEY, getGarageId } from '../../lib/auth';
import { useLang } from '@/app/i18n/LocaleProvider';

function CallbackContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const lang = useLang();
  const c = {
    en: {
      confirmFailed: 'Failed to confirm payment setup',
      cancelled: 'Payment setup was cancelled. Please try again.',
      missingFlowId: 'Invalid callback - missing redirect flow ID',
      logoAlt: 'ReceptionMate Logo',
      processingTitle: 'Processing Payment Setup',
      processingBody: 'Please wait while we confirm your Direct Debit mandate...',
      completeTitle: 'Payment Setup Complete!',
      completeBody: 'Your Direct Debit has been set up successfully. Redirecting to your dashboard...',
      failedTitle: 'Payment Setup Failed',
      tryAgain: 'Try Again',
    },
    fr: {
      confirmFailed: 'Échec de la confirmation de la configuration du paiement',
      cancelled: 'La configuration du paiement a été annulée. Veuillez réessayer.',
      missingFlowId: "Rappel invalide - identifiant de flux de redirection manquant",
      logoAlt: 'ReceptionMate Logo',
      processingTitle: 'Traitement de la configuration du paiement',
      processingBody: 'Veuillez patienter pendant que nous confirmons votre mandat de prélèvement automatique...',
      completeTitle: 'Configuration du paiement terminée !',
      completeBody: 'Votre prélèvement automatique a été configuré avec succès. Redirection vers votre tableau de bord...',
      failedTitle: 'Échec de la configuration du paiement',
      tryAgain: 'Réessayer',
    },
  }[lang];
  const [status, setStatus] = useState<'processing' | 'success' | 'error'>('processing');
  const [errorMessage, setErrorMessage] = useState<string>('');

  const confirmMandateMutation = useMutation({
    mutationFn: async (redirectFlowId: string) => {
      const token = localStorage.getItem(TOKEN_STORAGE_KEY);
      if (!token) {
        throw new Error('Not authenticated');
      }

      const response = await fetch(`/internal-api/payment/confirm-mandate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ redirectFlowId }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || c.confirmFailed);
      }

      return response.json();
    },
    onSuccess: () => {
      setStatus('success');
      sessionStorage.removeItem('gocardless_redirect_flow_id');
      // Redirect to calls page with setup wizard trigger after a short delay
      setTimeout(() => {
        router.push('/calls?showSetup=true');
      }, 2000);
    },
    onError: (error: Error) => {
      setStatus('error');
      setErrorMessage(error.message || c.confirmFailed);
    },
  });

  useEffect(() => {
    const redirectFlowId = searchParams.get('redirect_flow_id');
    const storedFlowId = sessionStorage.getItem('gocardless_redirect_flow_id');

    // Check if user cancelled
    if (searchParams.get('cancelled') === 'true') {
      setStatus('error');
      setErrorMessage(c.cancelled);
      return;
    }

    // Validate we have a redirect flow ID
    if (!redirectFlowId) {
      setStatus('error');
      setErrorMessage(c.missingFlowId);
      return;
    }

    // Confirm the mandate with the backend
    confirmMandateMutation.mutate(redirectFlowId);
  }, [searchParams]);

  if (status === 'processing') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-white px-4 text-slate-900">
        <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-2xl shadow-slate-900/10">
          <div className="text-center">
            <div className="mx-auto mb-6 flex justify-center">
              <img
                src="https://storage.googleapis.com/msgsndr/2UadumwHCXxeU9yxBIRC/media/65cf28be6e4392e608cca8a9.png"
                alt={c.logoAlt}
                className="h-24 w-auto"
              />
            </div>
            <div className="mb-4 flex justify-center">
              <div className="h-12 w-12 animate-spin rounded-full border-4 border-slate-300 border-t-sky-500"></div>
            </div>
            <h1 className="text-2xl font-semibold">{c.processingTitle}</h1>
            <p className="mt-2 text-sm text-slate-500">
              {c.processingBody}
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (status === 'success') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-white px-4 text-slate-900">
        <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-2xl shadow-slate-900/10">
          <div className="text-center">
            <div className="mx-auto mb-6 flex justify-center">
              <img
                src="https://storage.googleapis.com/msgsndr/2UadumwHCXxeU9yxBIRC/media/65cf28be6e4392e608cca8a9.png"
                alt={c.logoAlt}
                className="h-24 w-auto"
              />
            </div>
            <div className="mb-4 flex justify-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-50">
                <svg
                  className="h-8 w-8 text-emerald-700"
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
            <h1 className="text-2xl font-semibold">{c.completeTitle}</h1>
            <p className="mt-2 text-sm text-slate-500">
              {c.completeBody}
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Error state
  return (
    <div className="flex min-h-screen items-center justify-center bg-white px-4 text-slate-900">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-2xl shadow-slate-900/10">
        <div className="text-center">
          <div className="mx-auto mb-6 flex justify-center">
            <img
              src="https://storage.googleapis.com/msgsndr/2UadumwHCXxeU9yxBIRC/media/65cf28be6e4392e608cca8a9.png"
              alt="ReceptionMate Logo"
              className="h-24 w-auto"
            />
          </div>
          <div className="mb-4 flex justify-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-rose-50">
              <svg
                className="h-8 w-8 text-rose-700"
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
          <h1 className="text-2xl font-semibold">{c.failedTitle}</h1>
          <p className="mt-2 text-sm text-slate-500">{errorMessage}</p>
          <button
            onClick={() => router.push('/setup-payment')}
            className="mt-6 w-full rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition-transform hover:bg-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
          >
            {c.tryAgain}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function CallbackPage() {
  const lang = useLang();
  const c = { en: { loading: 'Loading...' }, fr: { loading: 'Chargement...' } }[lang];
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-white text-slate-900">
          <div className="text-slate-500">{c.loading}</div>
        </div>
      }
    >
      <CallbackContent />
    </Suspense>
  );
}
