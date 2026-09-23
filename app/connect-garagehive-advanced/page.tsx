'use client';

// The page GarageHive open from the "Garage Link Advanced" email. Sibling of
// /connect-garagehive, which wires the online-booking diary with a single instance field.
//
// This one collects the BUSINESS CENTRAL credentials instead — the ones that only exist once a
// garage upgrades to Garage Link Advanced — because service history, caller recognition and
// MOT/service reminders all read from BC rather than the booking API. One set of credentials per
// company, plus a location code per branch, which is why this can't be another field on the
// other form.
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import axios from 'axios';

// Same origin resolution as the sibling page. Deliberately not app/lib/api.ts: that client
// attaches the portal session token, and GarageHive open this with no login at all.
const backendOrigin = (process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:4000').replace(/\/$/, '');

type Branch = { id: string; name: string; locationCode: string };
type Result = { linkedCount: number; skippedCount: number; businessName: string };

function ConnectAdvancedForm() {
  const params = useSearchParams();
  const token = params.get('token') || '';

  const [checking, setChecking] = useState(true);
  const [businessName, setBusinessName] = useState('');
  const [branches, setBranches] = useState<Branch[]>([]);
  const [linkError, setLinkError] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [environmentName, setEnvironmentName] = useState('Production');
  const [companyId, setCompanyId] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<Result | null>(null);

  // Check the link before showing the form — an expired link should say so up front, not after
  // somebody has typed a tenant ID and five location codes in.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!token) {
        setLinkError('This link is missing its token. Please use the link from the email.');
        setChecking(false);
        return;
      }
      try {
        const { data } = await axios.get(`${backendOrigin}/api/garagehive-advanced/validate`, {
          params: { token },
        });
        if (cancelled) return;
        setBusinessName(data?.businessName || 'this business');
        const list: Branch[] = Array.isArray(data?.branches) ? data.branches : [];
        setBranches(list);
        setCodes(Object.fromEntries(list.map((b) => [b.id, b.locationCode || ''])));
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

  const anyCode = Object.values(codes).some((c) => c.trim());
  const canSubmit = tenantId.trim() && companyId.trim() && anyCode && !submitting;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError('');
    try {
      const { data } = await axios.post(`${backendOrigin}/api/garagehive-advanced/submit`, {
        token,
        tenantId: tenantId.trim(),
        environmentName: environmentName.trim() || 'Production',
        companyId: companyId.trim(),
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
        locations: codes,
      });
      setResult({
        linkedCount: data?.linkedCount ?? 0,
        skippedCount: data?.skippedCount ?? 0,
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

  const field = (
    id: string,
    label: string,
    value: string,
    onChange: (v: string) => void,
    hint?: string,
    type: 'text' | 'password' = 'text',
  ) => (
    <div className="mb-4">
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-slate-700">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
        className="w-full rounded-md border border-slate-300 px-3 py-2 text-slate-900 focus:border-[#3426cf] focus:outline-none focus:ring-1 focus:ring-[#3426cf]"
      />
      {hint && <p className="mt-1 text-xs text-slate-400">{hint}</p>}
    </div>
  );

  if (checking) return shell(<p className="text-slate-500">Checking your link…</p>);

  if (linkError)
    return shell(
      <>
        <h1 className="mb-3 text-xl font-bold text-slate-900">This link isn&rsquo;t valid</h1>
        <p className="text-[15px] leading-relaxed text-slate-600">{linkError}</p>
        <p className="mt-4 text-[15px] leading-relaxed text-slate-600">
          Links are valid for 14 days. Reply to the email and we&rsquo;ll send a fresh one.
        </p>
      </>,
    );

  if (result)
    return shell(
      <>
        <h1 className="mb-3 text-xl font-bold text-slate-900">Thank you — that&rsquo;s connected</h1>
        <p className="text-[15px] leading-relaxed text-slate-600">
          {result.linkedCount === 1
            ? `We've linked 1 branch of ${result.businessName} to Business Central.`
            : `We've linked ${result.linkedCount} branches of ${result.businessName} to Business Central.`}{' '}
          Service history, caller recognition and MOT reminders are now live for them.
        </p>
        {result.skippedCount > 0 && (
          <p className="mt-3 text-[15px] leading-relaxed text-slate-600">
            {result.skippedCount === 1
              ? '1 branch was left without a location code — send us the code and we’ll finish it.'
              : `${result.skippedCount} branches were left without a location code — send us the codes and we'll finish them.`}
          </p>
        )}
        <p className="mt-4 text-sm text-slate-400">You can close this page.</p>
      </>,
    );

  return shell(
    <>
      <h1 className="mb-3 text-xl font-bold text-slate-900">Garage Link Advanced</h1>
      <p className="mb-6 text-[15px] leading-relaxed text-slate-600">
        <strong>{businessName}</strong> has upgraded to Garage Link Advanced. Fill in their
        Business Central details below and we&rsquo;ll connect service history, caller recognition
        and MOT reminders automatically.
      </p>
      <form onSubmit={submit}>
        {field('tenantId', 'Tenant ID', tenantId, setTenantId, 'The Azure AD / Business Central tenant GUID.')}
        {field('environmentName', 'Environment', environmentName, setEnvironmentName, 'Usually "Production".')}
        {field('companyId', 'Company ID', companyId, setCompanyId, 'The Business Central company GUID or name.')}
        {field('clientId', 'API client ID', clientId, setClientId, 'Optional — leave blank if we authorise with our own app registration.')}
        {field('clientSecret', 'API client secret', clientSecret, setClientSecret, 'Optional. Never shown again once saved.', 'password')}

        <div className="mt-6 mb-2 border-t border-slate-200 pt-5">
          <p className="text-sm font-medium text-slate-700">Location code for each branch</p>
          <p className="mt-1 mb-3 text-xs text-slate-400">
            The code Business Central uses for each site. Leave a branch blank if it isn&rsquo;t on
            Garage Link Advanced.
          </p>
          {branches.length === 0 && (
            <p className="text-sm text-slate-500">No branches found for this business.</p>
          )}
          {branches.map((b) => (
            <div key={b.id} className="mb-3">
              <label htmlFor={`loc-${b.id}`} className="mb-1 block text-sm text-slate-600">
                {b.name}
              </label>
              <input
                id={`loc-${b.id}`}
                value={codes[b.id] ?? ''}
                onChange={(e) => setCodes((c) => ({ ...c, [b.id]: e.target.value }))}
                autoComplete="off"
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-slate-900 focus:border-[#3426cf] focus:outline-none focus:ring-1 focus:ring-[#3426cf]"
              />
            </div>
          ))}
        </div>

        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={!canSubmit}
          className="mt-4 w-full rounded-lg bg-[#3426cf] px-6 py-3 font-bold text-white transition hover:bg-[#2a1fa8] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? 'Connecting…' : 'Connect Garage Link Advanced'}
        </button>
      </form>
      <p className="mt-4 text-sm leading-relaxed text-slate-400">
        Credentials are stored against the garage&rsquo;s account and used only to read their
        service history and MOT dates.
      </p>
    </>,
  );
}

export default function ConnectGarageHiveAdvancedPage() {
  return (
    <Suspense fallback={<main className="min-h-screen bg-slate-100" />}>
      <ConnectAdvancedForm />
    </Suspense>
  );
}
