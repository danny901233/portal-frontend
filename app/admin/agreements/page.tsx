'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { isReceptionMateStaff } from '../../lib/auth';
import api from '../../lib/api';

type AdminAgreement = {
  id: string;
  type: string;
  version: string;
  status: 'draft' | 'sent' | 'signed' | 'externally_signed' | 'voided';
  clientName: string;
  setupFeeGbp: number;
  licenceFeeGbp: number;
  centresCount: number;
  licences: string[];
  goLiveDate: string | null;
  signedAt: string | null;
  signedByName: string | null;
  externallySignedAt: string | null;
  externalSignatureRef: string | null;
  createdAt: string;
  user: { email: string };
};

type GhBranch = {
  garageId: string;
  garageName: string;
  matchedLocationId: number | null;
  confidence: 'auto' | 'high' | 'low' | 'none';
  score: number;
  runnerUpScore: number;
  currentLocationId: string | null;
};
type GhPreview = {
  instance: string;
  locations: { id: number; name: string; address: string }[];
  branches: GhBranch[];
  garageCount: number;
  agreementCentresCount: number | null;
};

export default function AdminAgreementsPage() {
  const router = useRouter();
  const [agreements, setAgreements] = useState<AdminAgreement[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  // Mark-external dialog
  // Connect GarageHive. GarageHive give us an instance and we resolve which location each branch
  // is; where the matcher is not confident it flags the branch for a human, and this is that
  // human. Completing it here also releases the go-live email, so it is the last step of a
  // sales-led onboarding, not just a data-entry screen.
  const [connectFor, setConnectFor] = useState<AdminAgreement | null>(null);
  const [ghInstance, setGhInstance] = useState('');
  const [ghBusy, setGhBusy] = useState(false);
  const [ghError, setGhError] = useState<string | null>(null);
  const [ghPreview, setGhPreview] = useState<GhPreview | null>(null);
  const [ghChoice, setGhChoice] = useState<Record<string, string>>({});
  const [ghDone, setGhDone] = useState<string | null>(null);

  // The signed PDF was only ever emailed at the moment of signing, so a copy that was lost or
  // went to the wrong address could not be retrieved. Fetched as a blob because the endpoint is
  // behind staff auth — a plain link would not carry the token.
  const downloadPdf = async (a: AdminAgreement) => {
    setBusyId(a.id);
    try {
      const res = await api.get(`/admin/agreements/${a.id}/pdf`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data as Blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `ReceptionMate-Agreement-${a.clientName.replace(/[^a-z0-9]+/gi, '-')}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError('Could not download that agreement.');
    } finally {
      setBusyId(null);
    }
  };

  const openConnect = (a: AdminAgreement) => {
    setConnectFor(a);
    setGhInstance('');
    setGhPreview(null);
    setGhChoice({});
    setGhError(null);
    setGhDone(null);
  };

  const previewConnect = async () => {
    if (!connectFor || !ghInstance.trim()) return;
    setGhBusy(true);
    setGhError(null);
    setGhPreview(null);
    try {
      const { data } = await api.post<GhPreview>('/admin/garagehive/preview', {
        agreementId: connectFor.id,
        instance: ghInstance.trim(),
      });
      setGhPreview(data);
      // Pre-select the matcher's guess so a confident row needs no clicks; a flagged one starts
      // blank rather than pre-filled with something we did not trust.
      const initial: Record<string, string> = {};
      for (const b of data.branches) {
        if (b.matchedLocationId != null && (b.confidence === 'auto' || b.confidence === 'high')) {
          initial[b.garageId] = String(b.matchedLocationId);
        }
      }
      setGhChoice(initial);
    } catch (e: any) {
      setGhError(e?.response?.data?.error ?? 'Could not reach GarageHive for that instance.');
    } finally {
      setGhBusy(false);
    }
  };

  const commitConnect = async () => {
    if (!ghPreview) return;
    const mappings = Object.entries(ghChoice)
      .filter(([, locationId]) => locationId)
      .map(([garageId, locationId]) => ({ garageId, locationId }));
    if (!mappings.length) {
      setGhError('Pick a location for at least one branch.');
      return;
    }
    setGhBusy(true);
    setGhError(null);
    try {
      const { data } = await api.post<{ connected: number }>('/admin/garagehive/connect', {
        instance: ghPreview.instance,
        mappings,
      });
      setGhDone(
        `Connected ${data.connected} branch${data.connected === 1 ? '' : 'es'}. If the agreement is signed, the go-live email with their login has gone out.`,
      );
      setGhPreview(null);
    } catch (e: any) {
      setGhError(e?.response?.data?.error ?? 'Could not save the connection.');
    } finally {
      setGhBusy(false);
    }
  };

  const [markFor, setMarkFor] = useState<AdminAgreement | null>(null);
  const [externalRef, setExternalRef] = useState('');
  const [externalDate, setExternalDate] = useState('');

  useEffect(() => {
    if (!isReceptionMateStaff()) {
      router.replace('/dashboard');
    }
  }, [router]);

  const load = useMemo(
    () =>
      async () => {
        setLoading(true);
        setError(null);
        try {
          const params = statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : '';
          const { data } = await api.get<{ agreements: AdminAgreement[] }>(`/admin/agreements${params}`);
          setAgreements(data.agreements ?? []);
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Failed to load agreements');
        } finally {
          setLoading(false);
        }
      },
    [statusFilter],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return agreements;
    return agreements.filter((a) =>
      a.clientName.toLowerCase().includes(q) || a.user.email.toLowerCase().includes(q),
    );
  }, [agreements, search]);

  const resend = async (id: string) => {
    setBusyId(id);
    try {
      await api.post(`/admin/agreements/${id}/send`);
      await load();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to resend');
    } finally {
      setBusyId(null);
    }
  };

  const submitMarkExternal = async () => {
    if (!markFor || !externalRef.trim()) return;
    setBusyId(markFor.id);
    try {
      await api.post(`/admin/agreements/${markFor.id}/mark-external`, {
        externalSignatureRef: externalRef.trim(),
        externallySignedAt: externalDate ? new Date(externalDate).toISOString() : undefined,
      });
      setMarkFor(null);
      setExternalRef('');
      setExternalDate('');
      await load();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to mark as externally signed');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-slate-900">Service agreements</h1>
        <p className="mt-1 text-sm text-slate-500">
          Manage portal-signed and externally-signed (High Level legacy) customer agreements.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          placeholder="Search by client name or email"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-64 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
        >
          <option value="">All statuses</option>
          <option value="draft">Draft</option>
          <option value="sent">Sent (awaiting sign)</option>
          <option value="signed">Signed in portal</option>
          <option value="externally_signed">Externally signed</option>
          <option value="voided">Voided</option>
        </select>
      </div>

      {error ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>
      ) : null}

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr>
              <Th>Client</Th>
              <Th>Email</Th>
              <Th>Status</Th>
              <Th>Terms</Th>
              <Th>Signed</Th>
              <Th>Created</Th>
              <Th>Actions</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-slate-500">
                  Loading…
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-slate-500">
                  No agreements match these filters.
                </td>
              </tr>
            ) : (
              filtered.map((a) => (
                <tr key={a.id}>
                  <Td>
                    <div className="font-medium text-slate-900">{a.clientName}</div>
                    <div className="text-xs text-slate-500">{a.centresCount} centre{a.centresCount === 1 ? '' : 's'} · {a.licences.join(', ')}</div>
                  </Td>
                  <Td>{a.user.email}</Td>
                  <Td><StatusPill status={a.status} /></Td>
                  <Td>
                    <div className="text-slate-900">{formatGbp(a.licenceFeeGbp)}/centre/mo</div>
                    <div className="text-xs text-slate-500">{a.setupFeeGbp > 0 ? `Setup ${formatGbp(a.setupFeeGbp)}` : 'No setup fee'}</div>
                  </Td>
                  <Td className="text-xs text-slate-500">
                    {a.signedAt ? (
                      <>{a.signedByName} · {fmtDate(a.signedAt)}</>
                    ) : a.externallySignedAt ? (
                      <>External: {a.externalSignatureRef} · {fmtDate(a.externallySignedAt)}</>
                    ) : (
                      '—'
                    )}
                  </Td>
                  <Td className="text-xs text-slate-500">{fmtDate(a.createdAt)}</Td>
                  <Td>
                    <div className="flex flex-wrap gap-2">
                      {(a.status === 'signed' || a.status === 'externally_signed') && (
                        <button
                          onClick={() => void downloadPdf(a)}
                          disabled={busyId === a.id}
                          className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                        >
                          {busyId === a.id ? 'Preparing…' : 'Download PDF'}
                        </button>
                      )}
                      {(a.status === 'signed' || a.status === 'externally_signed') && (
                        <button
                          onClick={() => openConnect(a)}
                          className="rounded-md border border-brand-600 bg-white px-2.5 py-1 text-xs font-medium text-brand-600 hover:bg-brand-50"
                        >
                          Connect GarageHive
                        </button>
                      )}
                      {(a.status === 'draft' || a.status === 'sent') && (
                        <>
                          <button
                            onClick={() => resend(a.id)}
                            disabled={busyId === a.id}
                            className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                          >
                            {busyId === a.id ? 'Sending…' : a.status === 'sent' ? 'Resend' : 'Send'}
                          </button>
                          <button
                            onClick={() => setMarkFor(a)}
                            className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                          >
                            Mark externally signed
                          </button>
                        </>
                      )}
                    </div>
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {connectFor ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-white p-6 shadow-xl">
            <h2 className="text-lg font-semibold text-slate-900">Connect GarageHive diary</h2>
            <p className="mt-1 text-sm text-slate-600">
              For <strong>{connectFor.clientName}</strong>. Paste the instance GarageHive gave us — we
              work out which location each branch is. Connecting also sends their go-live email.
            </p>

            {ghDone ? (
              <>
                <p className="mt-5 rounded-lg bg-green-50 p-4 text-sm text-green-800">{ghDone}</p>
                <div className="mt-5 flex justify-end">
                  <button
                    onClick={() => setConnectFor(null)}
                    className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
                  >
                    Done
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="mt-4 flex gap-2">
                  <input
                    value={ghInstance}
                    onChange={(e) => setGhInstance(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void previewConnect(); }}
                    className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-brand-600 focus:outline-none"
                  />
                  <button
                    onClick={() => void previewConnect()}
                    disabled={!ghInstance.trim() || ghBusy}
                    className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
                  >
                    {ghBusy && !ghPreview ? 'Checking…' : 'Look up'}
                  </button>
                </div>

                {ghError ? <p className="mt-3 text-sm text-red-600">{ghError}</p> : null}

                {ghPreview ? (
                  <div className="mt-5">
                    <p className="text-xs uppercase tracking-wide text-slate-500">
                      {ghPreview.branches.length} branch{ghPreview.branches.length === 1 ? '' : 'es'} ·{' '}
                      {ghPreview.locations.length} location{ghPreview.locations.length === 1 ? '' : 's'} in this instance
                      {ghPreview.agreementCentresCount != null
                        ? ` · agreement says ${ghPreview.agreementCentresCount} centre${ghPreview.agreementCentresCount === 1 ? '' : 's'}`
                        : ''}
                    </p>
                    <div className="mt-3 space-y-3">
                      {ghPreview.branches.map((b) => (
                        <div key={b.garageId} className="rounded-lg border border-slate-200 p-3">
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-sm font-medium text-slate-900">{b.garageName}</span>
                            <span
                              className={
                                'rounded-full px-2 py-0.5 text-xs font-medium ' +
                                (b.confidence === 'auto' || b.confidence === 'high'
                                  ? 'bg-green-100 text-green-800'
                                  : 'bg-amber-100 text-amber-800')
                              }
                            >
                              {b.confidence === 'auto' || b.confidence === 'high'
                                ? 'matched'
                                : 'needs a pick'}
                            </span>
                          </div>
                          <select
                            value={ghChoice[b.garageId] ?? ''}
                            onChange={(e) =>
                              setGhChoice((c) => ({ ...c, [b.garageId]: e.target.value }))
                            }
                            className="mt-2 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-brand-600 focus:outline-none"
                          >
                            <option value="">— don&rsquo;t connect this branch —</option>
                            {ghPreview.locations.map((l) => (
                              <option key={l.id} value={String(l.id)}>
                                {l.name}
                                {l.address ? ` — ${l.address}` : ''}
                              </option>
                            ))}
                          </select>
                          {b.currentLocationId ? (
                            <p className="mt-1 text-xs text-slate-500">
                              Already connected to location {b.currentLocationId}.
                            </p>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                <div className="mt-6 flex justify-end gap-2">
                  <button
                    onClick={() => setConnectFor(null)}
                    className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => void commitConnect()}
                    disabled={!ghPreview || ghBusy}
                    className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
                  >
                    {ghBusy && ghPreview ? 'Connecting…' : 'Connect'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}

      {markFor ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
            <h2 className="text-lg font-semibold text-slate-900">Mark as externally signed</h2>
            <p className="mt-1 text-sm text-slate-600">
              For legacy customers who already signed via High Level. This clears the portal sign gate
              for <strong>{markFor.user.email}</strong>.
            </p>
            <div className="mt-4 space-y-3">
              <div>
                <label className="block text-xs font-medium uppercase tracking-wide text-slate-600">External reference</label>
                <input
                  value={externalRef}
                  onChange={(e) => setExternalRef(e.target.value)}
                  placeholder="e.g. HL envelope #12345"
                  className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
                />
              </div>
              <div>
                <label className="block text-xs font-medium uppercase tracking-wide text-slate-600">Signed on (optional)</label>
                <input
                  type="date"
                  value={externalDate}
                  onChange={(e) => setExternalDate(e.target.value)}
                  className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
                />
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setMarkFor(null)}
                className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                onClick={submitMarkExternal}
                disabled={!externalRef.trim() || busyId === markFor.id}
                className="rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:bg-slate-300"
              >
                {busyId === markFor.id ? 'Saving…' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
      {children}
    </th>
  );
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-3 text-sm text-slate-900 ${className ?? ''}`}>{children}</td>;
}

function StatusPill({ status }: { status: AdminAgreement['status'] }) {
  const map: Record<AdminAgreement['status'], string> = {
    draft: 'bg-slate-100 text-slate-700 ring-slate-200',
    sent: 'bg-amber-50 text-amber-800 ring-amber-200',
    signed: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
    externally_signed: 'bg-violet-50 text-violet-800 ring-violet-200',
    voided: 'bg-rose-50 text-rose-700 ring-rose-200',
  };
  const label: Record<AdminAgreement['status'], string> = {
    draft: 'Draft',
    sent: 'Sent',
    signed: 'Signed',
    externally_signed: 'External',
    voided: 'Voided',
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${map[status]}`}>
      {label[status]}
    </span>
  );
}

function formatGbp(n: number): string {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(n);
}

function fmtDate(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(iso));
}
