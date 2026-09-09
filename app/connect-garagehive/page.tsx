'use client';

// The page GarageHive open from the "New ReceptionMate onboard" email. One field: the garage's
// online-booking instance. Everything else — which branches exist, which location each one maps
// to — is worked out server-side, because we know which branches we onboarded and GarageHive
// does not.
//
// REBUILT 2026-09-09. This route existed (the 4 Aug frontend build logs list it) but its source
// was never committed and did not survive. The backend it talks to was recovered the same day;
// this is written against those endpoints rather than from the original, which is gone.
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import axios from 'axios';

// Same origin resolution as app/lib/api.ts. Not reusing that client on purpose: it attaches the
// portal session token, and this page is opened by GarageHive with no login at all.
const backendOrigin = (process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:4000').replace(/\/$/, '');

type Result = { connectedCount: number; flaggedCount: number; businessName: string };

function ConnectGarageHiveForm() {
  const params = useSearchParams();
  const token = params.get('token') || '';

  const [checking, setChecking] = useState(true);
  const [businessName, setBusinessName] = useState('');
  const [linkError, setLinkError] = useState('');
  const [instance, setInstance] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<Result | null>(null);

  // Check the link before showing the form — an expired link should say so up front rather than
  // after somebody has typed the instance in.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!token) {
        setLinkError('This link is missing its token. Please use the link from the email.');
        setChecking(false);
        return;
      }
      try {
        const { data } = await axios.get(
          `${backendOrigin}/api/garagehive-connect/validate`,
          { params: { token } },
        );
        if (cancelled) return;
        setBusinessName(data?.businessName || 'this business');
      } catch (e) {
        if (cancelled) return;
        setLinkError(
          axios.isAxiosError(e) && e.response?.data?.error
            ? String(e.response.data.error)
            : 'This link is invalid or has expired.',
        );
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = instance.trim();
    if (!value || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const { data } = await axios.post(`${backendOrigin}/api/garagehive-connect/submit`, {
        token,
        instance: value,
      });
      setResult({
        connectedCount: data?.connectedCount ?? 0,
        flaggedCount: data?.flaggedCount ?? 0,
        businessName: data?.businessName ?? businessName,
      });
    } catch (e) {
      setError(
        axios.isAxiosError(e) && e.response?.data?.error
          ? String(e.response.data.error)
          : 'Something went wrong. Please try again, or reply to the email and we will sort it.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  const shell = (inner: React.ReactNode) => (
    <main className="min-h-screen bg-slate-100 px-5 py-12">
      <div className="mx-auto w-full max-w-xl overflow-hidden rounded-2xl bg-white shadow-lg">
        <div className="bg-[#3426cf] px-8 py-6">
          <p className="text-lg font-bold tracking-tight text-white">ReceptionMate</p>
        </div>
        <div className="px-8 py-8">{inner}</div>
      </div>
    </main>
  );

  if (checking) return shell(<p className="text-slate-500">Checking your link…</p>);

  if (linkError)
    return shell(
      <>
        <h1 className="mb-3 text-xl font-bold text-slate-900">This link isn&rsquo;t valid</h1>
        <p className="text-[15px] leading-relaxed text-slate-600">{linkError}</p>
        <p className="mt-4 text-[15px] leading-relaxed text-slate-600">
          Links are valid for 14 days. Reply to the onboarding email and we&rsquo;ll send a fresh one.
        </p>
      </>,
    );

  if (result)
    return shell(
      <>
        <h1 className="mb-3 text-xl font-bold text-slate-900">Thank you — that&rsquo;s connected</h1>
        <p className="text-[15px] leading-relaxed text-slate-600">
          {result.connectedCount === 1
            ? `We've connected 1 branch of ${result.businessName} to the diary.`
            : `We've connected ${result.connectedCount} branches of ${result.businessName} to the diary.`}
        </p>
        {result.flaggedCount > 0 && (
          <p className="mt-3 text-[15px] leading-relaxed text-slate-600">
            {result.flaggedCount === 1
              ? '1 branch needs a quick check at our end — nothing further needed from you.'
              : `${result.flaggedCount} branches need a quick check at our end — nothing further needed from you.`}
          </p>
        )}
        <p className="mt-4 text-[15px] leading-relaxed text-slate-600">
          We place one test booking per branch to confirm it works, marked{' '}
          <em>receptionmate test booking please cancel</em> — please cancel those in GarageHive.
        </p>
        <p className="mt-4 text-sm text-slate-400">You can close this page.</p>
      </>,
    );

  return shell(
    <>
      <h1 className="mb-3 text-xl font-bold text-slate-900">Connect the GarageHive diary</h1>
      <p className="mb-6 text-[15px] leading-relaxed text-slate-600">
        <strong>{businessName}</strong> is being onboarded to ReceptionMate Automate. Paste their
        GarageHive <strong>instance</strong> below — that&rsquo;s all we need. We&rsquo;ll work out
        the branches and locations ourselves.
      </p>
      <form onSubmit={submit}>
        <label htmlFor="instance" className="mb-2 block text-sm font-medium text-slate-700">
          GarageHive instance
        </label>
        <input
          id="instance"
          value={instance}
          onChange={(e) => setInstance(e.target.value)}
          placeholder="e.g. mallory-performance"
          autoComplete="off"
          autoFocus
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-slate-900 focus:border-[#3426cf] focus:outline-none focus:ring-1 focus:ring-[#3426cf]"
        />
        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={!instance.trim() || submitting}
          className="mt-6 w-full rounded-lg bg-[#3426cf] px-6 py-3 font-bold text-white transition hover:bg-[#2a1fa8] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? 'Connecting…' : 'Connect diary'}
        </button>
      </form>
      <p className="mt-4 text-sm leading-relaxed text-slate-400">
        This connects the diary and places one marked test booking per branch so we can confirm it
        works. Please cancel those in GarageHive afterwards.
      </p>
    </>,
  );
}

export default function ConnectGarageHivePage() {
  return (
    <Suspense fallback={<main className="min-h-screen bg-slate-100" />}>
      <ConnectGarageHiveForm />
    </Suspense>
  );
}
