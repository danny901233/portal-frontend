'use client';

// The page GarageHive open from the "New ReceptionMate onboard" email.
//
// TWO sections, one submit. The instance wires the online-booking diary and is all that is
// strictly needed; the Business Central details underneath wire Garage Link Advanced, which is
// what gives the agent service history and caller recognition. Advanced used to be an upgrade
// sold separately, and the request for it was a second email to a function nothing ever called —
// which is why only three garages in the fleet have a BC connection and why every one of their
// callers is told "we haven't seen this vehicle before". It is standard on a new garage now, so
// it is asked for here, once, while somebody has the account open.
//
// The BC half stays OPTIONAL on purpose. Requiring it would let a missing tenant GUID block the
// diary connect, and the diary is the part that makes the agent work at all.
//
// Both halves use the SAME token (signConnectToken is per-business, not per-form), so this page
// can post to both existing endpoints and neither backend route needed changing.
//
// Everything else — which branches exist, which location each maps to — is worked out
// server-side, because we know which branches we onboarded and GarageHive does not.
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

type Result = {
  connectedCount: number;
  flaggedCount: number;
  businessName: string;
  /** null = not attempted (nothing filled in), true/false = the BC submit's outcome. */
  advanced: boolean | null;
  advancedError?: string;
};

type Branch = { id: string; name: string; locationCode?: string | null };

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

  // Garage Link Advanced (Business Central). Optional — see the note at the top.
  const [tenantId, setTenantId] = useState('');
  const [environmentName, setEnvironmentName] = useState('Production');
  const [companyId, setCompanyId] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [branches, setBranches] = useState<Branch[]>([]);
  const [codes, setCodes] = useState<Record<string, string>>({});

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
        // Branches for the per-branch BC location codes. A failure here must not stop the page:
        // the instance is the part that matters, so fall back to no location-code section.
        try {
          const adv = await axios.get(`${backendOrigin}/api/garagehive-advanced/validate`, {
            params: { token },
          });
          if (cancelled) return;
          const list: Branch[] = adv.data?.branches ?? [];
          setBranches(list);
          setCodes(Object.fromEntries(list.map((b) => [b.id, b.locationCode ?? ''])));
        } catch {
          if (!cancelled) setBranches([]);
        }
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

  // "Did they fill in Advanced?" — the backend needs tenant AND company, so both decide it.
  const advancedSupplied = Boolean(tenantId.trim() && companyId.trim());
  // Something typed, but not the two required fields: worth saying so before they submit rather
  // than silently dropping what they entered.
  const advancedPartial =
    !advancedSupplied &&
    Boolean(tenantId.trim() || companyId.trim() || clientId.trim() || clientSecret.trim() ||
      Object.values(codes).some((c) => c.trim()));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = instance.trim();
    if (!value || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      // The diary FIRST, and on its own. It is the half that must not fail, and a bad Business
      // Central GUID must never be the reason a garage's agent cannot book.
      const { data } = await axios.post(`${backendOrigin}/api/garagehive-connect/submit`, {
        token,
        instance: value,
      });

      // Then Advanced, only if they actually filled it in. The backend requires tenant and
      // company, so anything short of both is treated as "not supplied" rather than sent to fail.
      let advanced: boolean | null = null;
      let advancedError: string | undefined;
      if (advancedSupplied) {
        try {
          await axios.post(`${backendOrigin}/api/garagehive-advanced/submit`, {
            token,
            tenantId: tenantId.trim(),
            environmentName: environmentName.trim() || 'Production',
            companyId: companyId.trim(),
            clientId: clientId.trim() || undefined,
            clientSecret: clientSecret.trim() || undefined,
            locations: codes,
          });
          advanced = true;
        } catch (e2) {
          // Reported on the success screen, not thrown: the diary IS connected, and telling
          // GarageHive otherwise would have them redo the part that already worked.
          advanced = false;
          advancedError =
            axios.isAxiosError(e2) && e2.response?.data?.error
              ? String(e2.response.data.error)
              : 'We could not save those Advanced details.';
        }
      }

      setResult({
        connectedCount: data?.connectedCount ?? 0,
        flaggedCount: data?.flaggedCount ?? 0,
        businessName: data?.businessName ?? businessName,
        advanced,
        advancedError,
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

  const bcField = (
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
        {result.advanced === true && (
          <p className="mt-3 text-[15px] leading-relaxed text-slate-600">
            Garage Link Advanced is connected too — service history and caller recognition are on.
          </p>
        )}
        {result.advanced === false && (
          <p className="mt-3 rounded-md bg-amber-50 px-4 py-3 text-[15px] leading-relaxed text-amber-900">
            The diary is connected, but we couldn&rsquo;t save the Garage Link Advanced details:{' '}
            {result.advancedError} Nothing is lost — reply to the onboarding email and we&rsquo;ll
            sort it. The diary works either way.
          </p>
        )}
        {result.advanced === null && (
          <p className="mt-3 text-[15px] leading-relaxed text-slate-600">
            We didn&rsquo;t receive any Garage Link Advanced details. The diary works without them;
            send them over whenever you have them and the agent will start recognising returning
            customers.
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
      <h1 className="mb-3 text-xl font-bold text-slate-900">Connect {businessName}</h1>
      <p className="mb-6 text-[15px] leading-relaxed text-slate-600">
        <strong>{businessName}</strong> is being onboarded to ReceptionMate Automate. There are two
        parts below — the diary, and Garage Link Advanced. We&rsquo;ll work out the branches and
        locations ourselves.
      </p>
      <form onSubmit={submit}>
        <label htmlFor="instance" className="mb-2 block text-sm font-medium text-slate-700">
          GarageHive instance
        </label>
        <input
          id="instance"
          value={instance}
          onChange={(e) => setInstance(e.target.value)}
          autoComplete="off"
          autoFocus
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-slate-900 focus:border-[#3426cf] focus:outline-none focus:ring-1 focus:ring-[#3426cf]"
        />

        <div className="mt-8 border-t border-slate-200 pt-6">
          <h2 className="text-base font-bold text-slate-900">Garage Link Advanced</h2>
          <p className="mt-1 mb-4 text-sm leading-relaxed text-slate-500">
            Their Business Central details. This is what lets the agent recognise a returning
            customer and see what was last done to the vehicle. Optional — if it isn&rsquo;t to
            hand, leave it blank and send the instance on its own.
          </p>

          {bcField('tenantId', 'Tenant ID', tenantId, setTenantId, 'The Azure AD / Business Central tenant GUID.')}
          {bcField('environmentName', 'Environment', environmentName, setEnvironmentName, 'Usually "Production".')}
          {bcField('companyId', 'Company ID', companyId, setCompanyId, 'The Business Central company GUID or name.')}
          {bcField('clientId', 'API client ID', clientId, setClientId, 'Optional — leave blank if we authorise with our own app registration.')}
          {bcField('clientSecret', 'API client secret', clientSecret, setClientSecret, 'Optional. Never shown again once saved.', 'password')}

          {branches.length > 0 && (
            <div className="mt-5">
              <p className="text-sm font-medium text-slate-700">Location code for each branch</p>
              <p className="mt-1 mb-3 text-xs text-slate-400">
                The code Business Central uses for each site. Leave a branch blank if it has no
                separate code.
              </p>
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
          )}

          {advancedPartial && (
            <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
              Tenant ID and Company ID are both needed to save the Advanced details. Without them
              we&rsquo;ll connect the diary only, and the rest can follow later.
            </p>
          )}
        </div>

        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={!instance.trim() || submitting}
          className="mt-6 w-full rounded-lg bg-[#3426cf] px-6 py-3 font-bold text-white transition hover:bg-[#2a1fa8] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting
            ? 'Connecting…'
            : advancedSupplied
              ? 'Connect diary + Advanced'
              : 'Connect diary'}
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
