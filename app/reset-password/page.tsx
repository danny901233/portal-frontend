'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState, Suspense } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useLang } from '@/app/i18n/LocaleProvider';

function ResetPasswordForm() {
  const lang = useLang();
  const c = {
    en: {
      failedReset: 'Failed to reset password',
      resetSuccess: 'Password reset successfully! Redirecting to login...',
      invalidToken: 'Invalid or missing reset token',
      minChars: 'Password must be at least 8 characters',
      noMatch: 'Passwords do not match',
      invalidLinkTitle: 'Invalid Reset Link',
      invalidLinkBody: 'This password reset link is invalid or has expired. Please request a new password reset.',
      backToLogin: 'Back to Login',
      resetTitle: 'Reset Your Password',
      resetSubtitle: 'Enter your new password below',
      newPassword: 'New Password',
      newPasswordPlaceholder: 'Enter new password (min 8 characters)',
      confirmPassword: 'Confirm Password',
      confirmPasswordPlaceholder: 'Confirm new password',
      resetting: 'Resetting Password…',
      resetButton: 'Reset Password',
    },
    fr: {
      failedReset: 'Échec de la réinitialisation du mot de passe',
      resetSuccess: 'Mot de passe réinitialisé avec succès ! Redirection vers la connexion...',
      invalidToken: 'Jeton de réinitialisation invalide ou manquant',
      minChars: 'Le mot de passe doit comporter au moins 8 caractères',
      noMatch: 'Les mots de passe ne correspondent pas',
      invalidLinkTitle: 'Lien de réinitialisation invalide',
      invalidLinkBody: 'Ce lien de réinitialisation du mot de passe est invalide ou a expiré. Veuillez demander une nouvelle réinitialisation.',
      backToLogin: 'Retour à la connexion',
      resetTitle: 'Réinitialisez votre mot de passe',
      resetSubtitle: 'Saisissez votre nouveau mot de passe ci-dessous',
      newPassword: 'Nouveau mot de passe',
      newPasswordPlaceholder: 'Saisissez le nouveau mot de passe (8 caractères min.)',
      confirmPassword: 'Confirmer le mot de passe',
      confirmPasswordPlaceholder: 'Confirmez le nouveau mot de passe',
      resetting: 'Réinitialisation en cours…',
      resetButton: 'Réinitialiser le mot de passe',
    },
  }[lang];
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token');

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const resetPasswordMutation = useMutation({
    mutationFn: async ({ token, password }: { token: string; password: string }) => {
      const response = await fetch('/internal-api/auth/reset-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ token, password }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || data.message || c.failedReset);
      }

      return data;
    },
    onSuccess: () => {
      setMessage({ type: 'success', text: c.resetSuccess });
      setTimeout(() => {
        router.push('/login');
      }, 2000);
    },
    onError: (error: Error) => {
      setMessage({ type: 'error', text: error.message });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null);

    if (!token) {
      setMessage({ type: 'error', text: c.invalidToken });
      return;
    }

    if (password.length < 8) {
      setMessage({ type: 'error', text: c.minChars });
      return;
    }

    if (password !== confirmPassword) {
      setMessage({ type: 'error', text: c.noMatch });
      return;
    }

    resetPasswordMutation.mutate({ token, password });
  };

  if (!token) {
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
            <h1 className="text-2xl font-semibold">{c.invalidLinkTitle}</h1>
            <p className="mt-2 text-sm text-slate-500">
              {c.invalidLinkBody}
            </p>
            <button
              onClick={() => router.push('/login')}
              className="mt-6 w-full rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition-transform hover:bg-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
              {c.backToLogin}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-white px-4 text-slate-900">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-2xl shadow-slate-900/10">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-6 flex justify-center">
            <img
              src="https://storage.googleapis.com/msgsndr/2UadumwHCXxeU9yxBIRC/media/65cf28be6e4392e608cca8a9.png"
              alt="ReceptionMate Logo"
              className="h-24 w-auto"
            />
          </div>
          <h1 className="text-2xl font-semibold">{c.resetTitle}</h1>
          <p className="mt-2 text-sm text-slate-500">{c.resetSubtitle}</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="space-y-2">
            <label htmlFor="password" className="block text-sm font-medium text-slate-600">
              {c.newPassword}
            </label>
            <input
              type="password"
              id="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 transition-colors focus:border-brand-600 focus:outline-none"
              placeholder={c.newPasswordPlaceholder}
              required
              minLength={8}
              autoComplete="new-password"
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="confirmPassword" className="block text-sm font-medium text-slate-600">
              {c.confirmPassword}
            </label>
            <input
              type="password"
              id="confirmPassword"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 transition-colors focus:border-brand-600 focus:outline-none"
              placeholder={c.confirmPasswordPlaceholder}
              required
              minLength={8}
              autoComplete="new-password"
            />
          </div>

          {message && (
            <div
              className={`rounded-lg border px-4 py-3 text-sm ${
                message.type === 'success'
                  ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
                  : 'border-rose-300 bg-rose-50 text-rose-800'
              }`}
            >
              {message.text}
            </div>
          )}

          <button
            type="submit"
            disabled={resetPasswordMutation.isPending}
            className="w-full rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition-transform hover:bg-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 disabled:cursor-not-allowed disabled:bg-slate-700"
          >
            {resetPasswordMutation.isPending ? c.resetting : c.resetButton}
          </button>

          <div className="text-center">
            <button
              type="button"
              onClick={() => router.push('/login')}
              className="text-sm text-brand-600 hover:text-brand-700 hover:underline"
            >
              {c.backToLogin}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  const lang = useLang();
  const c = { en: { loading: 'Loading...' }, fr: { loading: 'Chargement...' } }[lang];
  return (
    <Suspense fallback={
      <div className="flex min-h-screen items-center justify-center bg-white text-slate-900">
        <div className="text-slate-500">{c.loading}</div>
      </div>
    }>
      <ResetPasswordForm />
    </Suspense>
  );
}
