'use client';

import { useMutation } from '@tanstack/react-query';
import type { AxiosError } from 'axios';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { login } from '../lib/api';
import { persistSession } from '../lib/auth';
import type { LoginResponse } from '../types';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const [resetEmail, setResetEmail] = useState('');
  const [resetMessage, setResetMessage] = useState('');

  const mutation = useMutation<LoginResponse, AxiosError>({
    mutationFn: async () => {
      const response = await login(email, password);
      return response;
    },
    onSuccess: (data: LoginResponse) => {
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
        throw new Error(error.error || 'Failed to send reset email');
      }
      return response.json();
    },
    onSuccess: () => {
      setResetMessage('Password reset link sent! Check your email.');
      setTimeout(() => {
        setShowForgotPassword(false);
        setResetMessage('');
        setResetEmail('');
      }, 3000);
    },
    onError: (error: Error) => {
      setResetMessage(error.message || 'Failed to send reset email. Please try again.');
    },
  });

  const errorMessage = useMemo(() => {
    if (!mutation.error) {
      return null;
    }

    const fallbackMessage = 'Unable to sign in. Please verify your credentials.';
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
  }, [mutation.error]);

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
          <h1 className="text-2xl font-semibold">Portal Login</h1>
          <p className="mt-2 text-sm text-slate-400">Sign in to continue to your calls dashboard</p>
        </div>

        {showForgotPassword ? (
          <div className="space-y-6">
            <div>
              <h2 className="text-lg font-semibold text-slate-100">Reset Password</h2>
              <p className="mt-1 text-sm text-slate-400">
                Enter your email address and we'll send you a password reset link.
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
                <label className="block text-sm font-medium text-slate-300" htmlFor="reset-email">
                  Email address
                </label>
                <input
                  id="reset-email"
                  type="email"
                  autoComplete="email"
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 transition-colors focus:border-sky-500 focus:outline-none"
                  value={resetEmail}
                  onChange={(e) => setResetEmail(e.target.value)}
                  required
                />
              </div>

              {resetMessage && (
                <p className={`text-sm ${resetMessage.includes('sent') ? 'text-green-400' : 'text-rose-400'}`}>
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
                  className="flex-1 rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-300 hover:border-slate-600"
                >
                  Back to Login
                </button>
                <button
                  type="submit"
                  className="flex-1 rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-400"
                  disabled={resetPasswordMutation.isPending}
                >
                  {resetPasswordMutation.isPending ? 'Sending...' : 'Send Reset Link'}
                </button>
              </div>
            </form>
          </div>
        ) : (
          <>
            <form
              className="space-y-6"
              onSubmit={(event) => {
                event.preventDefault();
                mutation.mutate();
              }}
            >
              <div className="space-y-2">
                <label className="block text-sm font-medium text-slate-300" htmlFor="email">
                  Email address
                </label>
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 transition-colors focus:border-sky-500 focus:outline-none"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                />
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-medium text-slate-300" htmlFor="password">
                  Password
                </label>
                <input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 transition-colors focus:border-sky-500 focus:outline-none"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
              </div>

              {mutation.isError && errorMessage ? (
                <p className="text-sm text-rose-400">{errorMessage}</p>
              ) : null}

              <button
                type="submit"
                className="w-full rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-white transition-transform hover:bg-sky-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
                disabled={mutation.isPending}
              >
                {mutation.isPending ? 'Signing in…' : 'Sign in'}
              </button>
            </form>

            <div className="mt-6 text-center">
              <button
                type="button"
                onClick={() => setShowForgotPassword(true)}
                className="text-sm text-sky-400 hover:text-sky-300 hover:underline"
              >
                Forgot your password?
              </button>
            </div>

            <p className="mt-4 text-center text-xs text-slate-500">
              Having trouble? Contact us at hello@receptionmate.co.uk
            </p>
          </>
        )}
      </div>
    </div>
  );
}
