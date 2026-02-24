'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState, Suspense } from 'react';
import { useMutation } from '@tanstack/react-query';

function ResetPasswordForm() {
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
        throw new Error(data.error || data.message || 'Failed to reset password');
      }

      return data;
    },
    onSuccess: () => {
      setMessage({ type: 'success', text: 'Password reset successfully! Redirecting to login...' });
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
      setMessage({ type: 'error', text: 'Invalid or missing reset token' });
      return;
    }

    if (password.length < 6) {
      setMessage({ type: 'error', text: 'Password must be at least 6 characters' });
      return;
    }

    if (password !== confirmPassword) {
      setMessage({ type: 'error', text: 'Passwords do not match' });
      return;
    }

    resetPasswordMutation.mutate({ token, password });
  };

  if (!token) {
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
            <h1 className="text-2xl font-semibold">Invalid Reset Link</h1>
            <p className="mt-2 text-sm text-slate-400">
              This password reset link is invalid or has expired. Please request a new password reset.
            </p>
            <button
              onClick={() => router.push('/login')}
              className="mt-6 w-full rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-white transition-transform hover:bg-sky-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
              Back to Login
            </button>
          </div>
        </div>
      </div>
    );
  }

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
          <h1 className="text-2xl font-semibold">Reset Your Password</h1>
          <p className="mt-2 text-sm text-slate-400">Enter your new password below</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="space-y-2">
            <label htmlFor="password" className="block text-sm font-medium text-slate-300">
              New Password
            </label>
            <input
              type="password"
              id="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 transition-colors focus:border-sky-500 focus:outline-none"
              placeholder="Enter new password"
              required
              minLength={6}
              autoComplete="new-password"
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="confirmPassword" className="block text-sm font-medium text-slate-300">
              Confirm Password
            </label>
            <input
              type="password"
              id="confirmPassword"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 transition-colors focus:border-sky-500 focus:outline-none"
              placeholder="Confirm new password"
              required
              minLength={6}
              autoComplete="new-password"
            />
          </div>

          {message && (
            <div
              className={`rounded-lg border px-4 py-3 text-sm ${
                message.type === 'success'
                  ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-200'
                  : 'border-rose-500/60 bg-rose-500/15 text-rose-200'
              }`}
            >
              {message.text}
            </div>
          )}

          <button
            type="submit"
            disabled={resetPasswordMutation.isPending}
            className="w-full rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-white transition-transform hover:bg-sky-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 disabled:cursor-not-allowed disabled:bg-slate-700"
          >
            {resetPasswordMutation.isPending ? 'Resetting Password…' : 'Reset Password'}
          </button>

          <div className="text-center">
            <button
              type="button"
              onClick={() => router.push('/login')}
              className="text-sm text-sky-400 hover:text-sky-300 hover:underline"
            >
              Back to Login
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={
      <div className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-100">
        <div className="text-slate-400">Loading...</div>
      </div>
    }>
      <ResetPasswordForm />
    </Suspense>
  );
}
