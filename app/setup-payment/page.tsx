'use client';

import { useMutation } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState, useEffect, Suspense } from 'react';
import { TOKEN_STORAGE_KEY } from '../lib/auth';
import { useLang } from '@/app/i18n/LocaleProvider';

function SetupPaymentContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const lang = useLang();
  const c = {
    en: {
      invalidLink: 'Invalid or expired link. Please request a new one.',
      verifyFailed: 'Failed to verify link',
      initiateFailed: 'Failed to initiate payment setup',
      setupFailed: 'Failed to set up payment. Please try again.',
      title: 'Set Up Direct Debit',
      subtitle: 'Complete your account setup by setting up your monthly subscription payment',
      whatToKnow: 'What you need to know:',
      point1: 'Secure Direct Debit payment via GoCardless',
      point2: 'Protected by the Direct Debit Guarantee',
      point3: "You'll be redirected to complete setup",
      point4: 'Takes less than 2 minutes',
      verifying: 'Verifying link...',
      settingUp: 'Setting up...',
      setUp: 'Set Up Direct Debit',
      agree: 'By continuing, you agree to set up a Direct Debit mandate for your ReceptionMate subscription.',
      logoAlt: 'ReceptionMate Logo',
    },
    fr: {
      invalidLink: 'Lien invalide ou expiré. Veuillez en demander un nouveau.',
      verifyFailed: 'Échec de la vérification du lien',
      initiateFailed: 'Échec du lancement de la configuration du paiement',
      setupFailed: 'Échec de la configuration du paiement. Veuillez réessayer.',
      title: 'Configurer le prélèvement automatique',
      subtitle: 'Finalisez la configuration de votre compte en mettant en place le paiement de votre abonnement mensuel',
      whatToKnow: 'Ce que vous devez savoir :',
      point1: 'Paiement sécurisé par prélèvement automatique via GoCardless',
      point2: 'Protégé par la garantie de prélèvement automatique',
      point3: 'Vous serez redirigé pour finaliser la configuration',
      point4: 'Cela prend moins de 2 minutes',
      verifying: 'Vérification du lien...',
      settingUp: 'Configuration en cours...',
      setUp: 'Configurer le prélèvement automatique',
      agree: 'En continuant, vous acceptez de mettre en place un mandat de prélèvement automatique pour votre abonnement ReceptionMate.',
      logoAlt: 'ReceptionMate Logo',
    },
  }[lang];
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
      const response = await fetch('/internal-api/auth/verify-magic-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: magicToken }),
      });

      if (!response.ok) {
        throw new Error(c.invalidLink);
      }

      const data = await response.json();
      // Store the auth token
      localStorage.setItem(TOKEN_STORAGE_KEY, data.token);
      setError(null);
    } catch (err: any) {
      setError(err.message || c.verifyFailed);
    } finally {
      setIsVerifyingToken(false);
    }
  };

  // Card rail: a manually-onboarded customer whose Business.billingMethod is 'stripe_card'.
  // Stripe Checkout at the price agreed on their contract, then straight into the setup wizard —
  // the same destination confirm-mandate sends a DD customer to.
  const cardCheckoutMutation = useMutation({
    mutationFn: async () => {
      const token = localStorage.getItem(TOKEN_STORAGE_KEY);
      if (!token) throw new Error('Not authenticated');
      const response = await fetch('/internal-api/payment/card-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Could not start the card checkout');
      }
      return response.json();
    },
    onSuccess: (data: { url: string }) => {
      window.location.href = data.url;
    },
    onError: (error: Error) => setError(error.message),
  });

  const createMandateMutation = useMutation({
    mutationFn: async () => {
      const token = localStorage.getItem(TOKEN_STORAGE_KEY);
      if (!token) {
        throw new Error('Not authenticated');
      }

      const response = await fetch('/internal-api/payment/create-mandate-flow', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || c.initiateFailed);
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
      setError(error.message || c.setupFailed);
    },
  });

  // Ask the server which rail this customer is on rather than guessing. Defaults to
  // directdebit server-side, so anyone predating billingMethod behaves exactly as before.
  const handleSetupPayment = async () => {
    setError(null);
    try {
      const token = localStorage.getItem(TOKEN_STORAGE_KEY);
      const res = await fetch('/internal-api/payment/method', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const { billingMethod } = await res.json();
      if (billingMethod === 'stripe_card') {
        cardCheckoutMutation.mutate();
        return;
      }
    } catch {
      // Rail lookup failed — fall through to Direct Debit, which is what everyone was on before
      // this existed. Better to show the wrong-but-working flow than a dead button.
    }
    return handleSetupPaymentDirectDebit();
  };

  const handleSetupPaymentDirectDebit = () => {
    setError(null);
    createMandateMutation.mutate();
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-white px-4 text-slate-900">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-2xl shadow-slate-900/10">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-6 flex justify-center">
            <img
              src="https://storage.googleapis.com/msgsndr/2UadumwHCXxeU9yxBIRC/media/65cf28be6e4392e608cca8a9.png"
              alt={c.logoAlt}
              className="h-24 w-auto"
            />
          </div>
          <h1 className="text-2xl font-semibold">{c.title}</h1>
          <p className="mt-2 text-sm text-slate-500">
            {c.subtitle}
          </p>
        </div>

        <div className="space-y-6">
          <div className="rounded-lg border border-slate-300 bg-slate-50 p-4">
            <h2 className="text-sm font-semibold text-slate-700 mb-2">{c.whatToKnow}</h2>
            <ul className="space-y-2 text-sm text-slate-500">
              <li className="flex items-start">
                <span className="mr-2 text-brand-600">•</span>
                <span>{c.point1}</span>
              </li>
              <li className="flex items-start">
                <span className="mr-2 text-brand-600">•</span>
                <span>{c.point2}</span>
              </li>
              <li className="flex items-start">
                <span className="mr-2 text-brand-600">•</span>
                <span>{c.point3}</span>
              </li>
              <li className="flex items-start">
                <span className="mr-2 text-brand-600">•</span>
                <span>{c.point4}</span>
              </li>
            </ul>
          </div>

          {error && (
            <div className="rounded-lg border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-800">
              {error}
            </div>
          )}

          <button
            onClick={handleSetupPayment}
            disabled={createMandateMutation.isPending || isVerifyingToken}
            className="w-full rounded-lg bg-brand-600 px-4 py-3 text-sm font-semibold text-white transition-transform hover:bg-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 disabled:cursor-not-allowed disabled:bg-slate-700"
          >
            {isVerifyingToken ? c.verifying : createMandateMutation.isPending ? c.settingUp : c.setUp}
          </button>

          <p className="text-center text-xs text-slate-500">
            {c.agree}
          </p>
        </div>
      </div>
    </div>
  );
}

export default function SetupPaymentPage() {
  const lang = useLang();
  const c = { en: { loading: 'Loading...' }, fr: { loading: 'Chargement...' } }[lang];
  return (
    <Suspense fallback={
      <div className="flex min-h-screen items-center justify-center bg-white px-4 text-slate-900">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-brand-600 mx-auto"></div>
          <p className="mt-4 text-slate-500">{c.loading}</p>
        </div>
      </div>
    }>
      <SetupPaymentContent />
    </Suspense>
  );
}
