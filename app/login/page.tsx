'use client';

import { useMutation } from '@tanstack/react-query';
import type { AxiosError } from 'axios';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { login } from '../lib/api';
import { persistSession, TOKEN_STORAGE_KEY } from '../lib/auth';
import type { LoginResponse } from '../types';
import { useLang } from '@/app/i18n/LocaleProvider';

export default function LoginPage() {
  const lang = useLang();
  const c = {
    en: {
      passwordChangeRequired: 'Password change required. Please request a reset link.',
      agreementAuthFailed: 'Service agreement signing required but authentication failed.',
      paymentAuthFailed: 'Payment setup required but authentication failed.',
      loginFailed: 'Login failed. Please try again.',
      resetSent: 'Password reset link sent! Check your email.',
      resetFailed: 'Failed to send reset email. Please try again.',
      resetFailedShort: 'Failed to send reset email',
      unableSignIn: 'Unable to sign in. Please verify your credentials.',
      welcomeBack: 'Welcome back',
      signInToContinue: 'Sign in to continue to your dashboard',
      resetPassword: 'Reset Password',
      resetIntro: "Enter your email address and we'll send you a password reset link.",
      emailLabel: 'Email address',
      backToLogin: 'Back to Login',
      sending: 'Sending...',
      sendResetLink: 'Send Reset Link',
      passwordLabel: 'Password',
      signingIn: 'Signing in…',
      signIn: 'Sign in',
      forgotPassword: 'Forgot your password?',
      trouble: 'Having trouble? Contact us at',
    },
    fr: {
      passwordChangeRequired: 'Changement de mot de passe requis. Veuillez demander un lien de réinitialisation.',
      agreementAuthFailed: "La signature du contrat de service est requise, mais l'authentification a échoué.",
      paymentAuthFailed: "La configuration du paiement est requise, mais l'authentification a échoué.",
      loginFailed: 'Échec de la connexion. Veuillez réessayer.',
      resetSent: 'Lien de réinitialisation du mot de passe envoyé ! Consultez votre e-mail.',
      resetFailed: "Échec de l'envoi de l'e-mail de réinitialisation. Veuillez réessayer.",
      resetFailedShort: "Échec de l'envoi de l'e-mail de réinitialisation",
      unableSignIn: 'Impossible de vous connecter. Veuillez vérifier vos identifiants.',
      welcomeBack: 'Bon retour',
      signInToContinue: 'Connectez-vous pour accéder à votre tableau de bord',
      resetPassword: 'Réinitialiser le mot de passe',
      resetIntro: 'Saisissez votre adresse e-mail et nous vous enverrons un lien de réinitialisation du mot de passe.',
      emailLabel: 'Adresse e-mail',
      backToLogin: 'Retour à la connexion',
      sending: 'Envoi en cours...',
      sendResetLink: 'Envoyer le lien de réinitialisation',
      passwordLabel: 'Mot de passe',
      signingIn: 'Connexion en cours…',
      signIn: 'Se connecter',
      forgotPassword: 'Mot de passe oublié ?',
      trouble: 'Un problème ? Contactez-nous à',
    },
  }[lang];
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const [resetEmail, setResetEmail] = useState('');
  const [resetMessage, setResetMessage] = useState('');
  const [loginMessage, setLoginMessage] = useState<string | null>(null);

  const mutation = useMutation<LoginResponse, AxiosError>({
    mutationFn: async () => {
      const response = await login(email, password);
      return response;
    },
    onSuccess: (data: LoginResponse) => {
      setLoginMessage(null);
      // Store the onboarding JWT up-front so every onboarding step
      // (password reset, agreement sign, DD setup) shares the same session.
      if (data.token) {
        localStorage.setItem(TOKEN_STORAGE_KEY, data.token);
      }
      if (data.passwordChangeRequired) {
        if (data.resetToken) {
          router.push(`/reset-password?token=${data.resetToken}`);
          return;
        }
        setLoginMessage(c.passwordChangeRequired);
        return;
      }
      if (data.agreementSignRequired) {
        if (data.token && data.user) {
          router.push('/agreement/sign');
          return;
        }
        setLoginMessage(c.agreementAuthFailed);
        return;
      }
      if (data.paymentSetupRequired) {
        if (data.token && data.user) {
          router.push('/setup-payment');
          return;
        }
        setLoginMessage(c.paymentAuthFailed);
        return;
      }
      if (!data.token || !data.user || !data.selectedGarageId || !data.garages) {
        setLoginMessage(c.loginFailed);
        return;
      }
      persistSession({
        token: data.token,
        garageId: data.selectedGarageId,
        garages: data.garages,
        userId: data.user.id,
        email: data.user.email,
        role: data.user.role,
        branchRoles: data.user.branchRoles,
      });
      router.push('/calls');
    },
  });

  const resetPasswordMutation = useMutation({
    mutationFn: async (emailAddress: string) => {
      const response = await fetch('/api/auth/request-password-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailAddress }),
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || c.resetFailedShort);
      }
      return response.json();
    },
    onSuccess: () => {
      setResetMessage(c.resetSent);
      setTimeout(() => {
        setShowForgotPassword(false);
        setResetMessage('');
        setResetEmail('');
      }, 3000);
    },
    onError: (error: Error) => {
      setResetMessage(error.message || c.resetFailed);
    },
  });

  const errorMessage = useMemo(() => {
    if (!mutation.error) {
      return null;
    }

    const fallbackMessage = c.unableSignIn;
    const rawResponseData = mutation.error.response?.data as { error?: unknown } | string | undefined;
    const payload = typeof rawResponseData === 'object' && rawResponseData !== null && 'error' in rawResponseData
      ? (rawResponseData as { error?: unknown }).error
      : rawResponseData;

    if (typeof payload === 'string' && payload.trim()) {
      return payload;
    }

    if (Array.isArray(payload)) {
      const firstString = payload.find((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
      if (firstString) {
        return firstString;
      }
    }

    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const flattened = payload as {
        formErrors?: unknown;
        fieldErrors?: Record<string, unknown>;
      };

      const formErrors = Array.isArray(flattened.formErrors) ? flattened.formErrors : [];
      const firstFormError = formErrors.find((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
      if (firstFormError) {
        return firstFormError;
      }

      const fieldErrors = flattened.fieldErrors;
      if (fieldErrors && typeof fieldErrors === 'object') {
        for (const value of Object.values(fieldErrors)) {
          if (typeof value === 'string' && value.trim().length > 0) {
            return value;
          }
          if (Array.isArray(value)) {
            const firstFieldError = value.find((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
            if (firstFieldError) {
              return firstFieldError;
            }
          }
        }
      }
    }

    if (typeof mutation.error.message === 'string' && mutation.error.message.trim()) {
      return mutation.error.message;
    }

    return fallbackMessage;
  }, [mutation.error, c]);

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-white px-4 text-slate-900">
      {/* Subtle brand glow background */}
      <div className="absolute inset-0 -z-10 overflow-hidden">
        <div className="absolute -top-40 left-1/2 h-96 w-[800px] -translate-x-1/2 rounded-full bg-brand-100/60 blur-3xl"></div>
        <div className="absolute top-20 -left-32 h-72 w-72 rounded-full bg-brand-200/30 blur-3xl"></div>
      </div>

      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-xl shadow-brand-900/5">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-6 flex justify-center">
            <span className="inline-flex h-16 items-center justify-center rounded-xl bg-brand-600 px-5 py-2.5">
              <img
                src="https://storage.googleapis.com/msgsndr/2UadumwHCXxeU9yxBIRC/media/65cf28be6e4392e608cca8a9.png"
                alt="ReceptionMate Logo"
                className="h-10 w-auto"
              />
            </span>
          </div>
          <h1 className="text-2xl font-semibold text-slate-900">{c.welcomeBack}</h1>
          <p className="mt-2 text-sm text-slate-500">{c.signInToContinue}</p>
        </div>

        {showForgotPassword ? (
          <div className="space-y-6">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">{c.resetPassword}</h2>
              <p className="mt-1 text-sm text-slate-500">
                {c.resetIntro}
              </p>
            </div>
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                setResetMessage('');
                resetPasswordMutation.mutate(resetEmail);
              }}
            >
              <div className="space-y-2">
                <label className="block text-sm font-medium text-slate-700" htmlFor="reset-email">
                  {c.emailLabel}
                </label>
                <input
                  id="reset-email"
                  type="email"
                  autoComplete="email"
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 transition-colors placeholder:text-slate-400 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/20"
                  value={resetEmail}
                  onChange={(e) => setResetEmail(e.target.value)}
                  required
                />
              </div>

              {resetMessage && (
                <p className={`text-sm ${resetMessage.includes('sent') ? 'text-emerald-700' : 'text-rose-700'}`}>
                  {resetMessage}
                </p>
              )}

              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setShowForgotPassword(false);
                    setResetMessage('');
                    setResetEmail('');
                  }}
                  className="flex-1 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:border-slate-400 hover:bg-slate-50 transition-colors"
                >
                  {c.backToLogin}
                </button>
                <button
                  type="submit"
                  className="flex-1 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-md shadow-brand-600/25 hover:bg-brand-700 transition-colors disabled:opacity-50"
                  disabled={resetPasswordMutation.isPending}
                >
                  {resetPasswordMutation.isPending ? c.sending : c.sendResetLink}
                </button>
              </div>
            </form>
          </div>
        ) : (
          <>
            <form
              className="space-y-5"
              onSubmit={(event) => {
                event.preventDefault();
                setLoginMessage(null);
                mutation.mutate();
              }}
            >
              <div className="space-y-2">
                <label className="block text-sm font-medium text-slate-700" htmlFor="email">
                  {c.emailLabel}
                </label>
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 transition-colors placeholder:text-slate-400 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/20"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                />
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-medium text-slate-700" htmlFor="password">
                  {c.passwordLabel}
                </label>
                <input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 transition-colors placeholder:text-slate-400 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/20"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
              </div>

              {mutation.isError && errorMessage ? (
                <p className="text-sm text-rose-700">{errorMessage}</p>
              ) : null}
              {loginMessage ? (
                <p className="text-sm text-amber-700">{loginMessage}</p>
              ) : null}

              <button
                type="submit"
                className="w-full rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white shadow-md shadow-brand-600/25 transition-colors hover:bg-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600/30 disabled:opacity-50"
                disabled={mutation.isPending}
              >
                {mutation.isPending ? c.signingIn : c.signIn}
              </button>
            </form>

            <div className="mt-6 text-center">
              <button
                type="button"
                onClick={() => setShowForgotPassword(true)}
                className="text-sm font-medium text-brand-600 hover:text-brand-700 hover:underline"
              >
                {c.forgotPassword}
              </button>
            </div>

            <p className="mt-4 text-center text-xs text-slate-500">
              {c.trouble}{' '}
              <a href="mailto:hello@receptionmate.co.uk" className="text-brand-600 hover:text-brand-700">
                hello@receptionmate.co.uk
              </a>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
