'use client';

// The page Bookar, Poole and Tyresoft open from the "New ReceptionMate onboard" email — the
// equivalent of /connect-garagehive for the providers who hand us credentials directly.
//
// Every field is described by the SERVER (GET /api/diary-connect/validate), not hard-coded here,
// so adding a provider or changing a field is a backend-only change. Shared values are asked
// once; anything that genuinely differs per site (Tyresoft depot, Poole branch key) is asked per
// branch, which is why a multi-branch group still gets one email and one form.
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import axios from 'axios';

// Same origin resolution as app/lib/api.ts. Deliberately not that client: it attaches the portal
// session token, and this page is opened by a GMS provider with no login at all.
const backendOrigin = (process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:4000').replace(/\/$/, '');

type Field = { key: string; label: string; required: boolean; secret?: boolean; help?: string; placeholder?: string };
type Branch = { id: string; name: string; address: string };
type Meta = {
  providerLabel: string;
  businessName: string;
  sharedFields: Field[];
  branchFields: Field[];
  branches: Branch[];
};
type Connected = { garageId: string; garageName: string; check: string; testBooking: string | null };

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: Field;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-slate-700">
        {field.label}
        {!field.required && <span className="ml-1 font-normal text-slate-400">(optional)</span>}
      </label>
      <input
        type={field.secret ? 'password' : 'text'}
        value={value}
        autoComplete="off"
        placeholder={field.placeholder || ''}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
      />
      {field.help && <p className="mt-1 text-xs text-slate-500">{field.help}</p>}
    </div>
  );
}

function ConnectDiaryForm() {
  const params = useSearchParams();
  const token = params.get('token') || '';

  const [checking, setChecking] = useState(true);
  const [linkError, setLinkError] = useState('');
  const [meta, setMeta] = useState<Meta | null>(null);
  const [shared, setShared] = useState<Record<string, string>>({});
  const [branchVals, setBranchVals] = useState<Record<string, Record<string, string>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState<Connected[] | null>(null);

  // Check the link before rendering anything — an expired link should say so up front, not after
  // somebody has typed a password in.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!token) {
        setLinkError('This link is missing its token. Please use the link from the email.');
        setChecking(false);
        return;
      }
      try {
        const { data } = await axios.get(`${backendOrigin}/api/diary-connect/validate`, {
          params: { token },
        });
        if (cancelled) return;
        setMeta(data);
      } catch (e) {
        if (!cancelled)
          setLinkError(
            (axios.isAxiosError(e) && (e.response?.data as { error?: string })?.error) ||
              'This link is invalid or has expired.',
          );
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const setBranchField = (gid: string, key: string, v: string) =>
    setBranchVals((prev) => ({ ...prev, [gid]: { ...(prev[gid] || {}), [key]: v } }));

  const submit = async () => {
    setError('');
    setSubmitting(true);
    try {
      const { data } = await axios.post(`${backendOrigin}/api/diary-connect/submit`, {
        token,
        shared,
        branches: branchVals,
      });
      setConnected(data.connected as Connected[]);
    } catch (e) {
      setError(
        (axios.isAxiosError(e) && (e.response?.data as { error?: string })?.error) ||
          'Something went wrong connecting the diary. Please try again.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (checking)
    return <p className="text-sm text-slate-500">Checking your link…</p>;

  if (linkError)
    return (
      <div className="rounded-lg border border-rose-200 bg-rose-50 p-4">
        <p className="text-sm text-rose-700">{linkError}</p>
      </div>
    );

  if (connected)
    return (
      <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-5">
        <h2 className="text-base font-semibold text-emerald-900">Diary connected</h2>
        <p className="mt-1 text-sm text-emerald-800">
          Thanks — nothing else is needed from you. We&apos;ll take it from here.
        </p>
        <ul className="mt-3 space-y-1">
          {connected.map((c) => (
            <li key={c.garageId} className="text-sm text-emerald-800">
              <span className="font-medium">{c.garageName}</span> — connected
              {c.testBooking ? ` (test booking ${c.testBooking}, please cancel it)` : ''}
            </li>
          ))}
        </ul>
      </div>
    );

  if (!meta) return null;

  return (
    <>
      <p className="mb-5 text-sm text-slate-600">
        <span className="font-semibold text-slate-900">{meta.businessName}</span> is being onboarded
        to ReceptionMate. Fill in their {meta.providerLabel} details below — submitting connects
        the diary, and nothing else is needed from you.
      </p>

      <div className="space-y-4">
        {meta.sharedFields.map((f) => (
          <FieldInput
            key={f.key}
            field={f}
            value={shared[f.key] || ''}
            onChange={(v) => setShared((p) => ({ ...p, [f.key]: v }))}
          />
        ))}
      </div>

      {meta.branchFields.length > 0 &&
        meta.branches.map((b) => (
          <div key={b.id} className="mt-6 rounded-lg border border-slate-200 bg-slate-50 p-4">
            <p className="text-sm font-semibold text-slate-900">{b.name}</p>
            {b.address && <p className="mb-3 text-xs text-slate-500">{b.address}</p>}
            <div className="space-y-4">
              {meta.branchFields.map((f) => (
                <FieldInput
                  key={f.key}
                  field={f}
                  value={branchVals[b.id]?.[f.key] || ''}
                  onChange={(v) => setBranchField(b.id, f.key, v)}
                />
              ))}
            </div>
          </div>
        ))}

      {error && (
        <div className="mt-5 rounded-lg border border-rose-200 bg-rose-50 p-3">
          <p className="text-sm text-rose-700">{error}</p>
        </div>
      )}

      <button
        type="button"
        onClick={submit}
        disabled={submitting}
        className="mt-6 w-full rounded-lg bg-brand-600 px-4 py-3 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {submitting ? 'Checking the details…' : `Connect ${meta.providerLabel} diary`}
      </button>
      <p className="mt-2 text-center text-xs text-slate-500">
        We check these against {meta.providerLabel} before saving, so you&apos;ll know straight away
        if anything is wrong.
      </p>
    </>
  );
}

export default function ConnectDiaryPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 p-4">
      <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-sm sm:p-8">
        <h1 className="mb-1 text-xl font-bold text-slate-900">Connect diary</h1>
        <p className="mb-5 text-xs text-slate-500">ReceptionMate onboarding</p>
        <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
          <ConnectDiaryForm />
        </Suspense>
      </div>
    </main>
  );
}
