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

export default function AdminAgreementsPage() {
  const router = useRouter();
  const [agreements, setAgreements] = useState<AdminAgreement[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  // Mark-external dialog
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
