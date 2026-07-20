'use client';

import { useEffect, useMemo, useState } from 'react';
import OnboardingPipeline from './OnboardingPipeline';
import { useRouter } from 'next/navigation';
import { isReceptionMateStaff } from '../../lib/auth';
import api from '../../lib/api';
import ConnectGarageHiveModal from '../components/ConnectGarageHiveModal';

type AdminAgreement = {
  id: string;
  type: string;
  version: string;
  status: 'draft' | 'sent' | 'signed' | 'externally_signed' | 'voided';
  clientName: string;
  setupFeeGbp: number;
  licenceFeeGbp: number;   // voice, per branch
  messagingFeeGbp: number; // Connect, per branch
  centresCount: number;
  licences: string[];
  goLiveDate: string | null;
  signedAt: string | null;
  signedByName: string | null;
  externallySignedAt: string | null;
  externalSignatureRef: string | null;
  createdAt: string;
  // Delivery + open tracking (recorded from /send and the sign page).
  sentToEmail: string | null;
  sentAt: string | null;
  firstViewedAt: string | null;
  lastViewedAt: string | null;
  viewCount: number;
  viewedFromIp: string | null;
  user: { email: string };
};

// "14 Jul, 09:02" — short enough for a table, precise enough to chase from.
function shortDateTime(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function sinceLabel(iso: string | null): string {
  if (!iso) return '';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export default function AdminAgreementsPage() {
  const router = useRouter();
  const [agreements, setAgreements] = useState<AdminAgreement[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [sendFor, setSendFor] = useState<AdminAgreement | null>(null);
  const [sendEmail, setSendEmail] = useState('');
  const [sendSms, setSendSms] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  // Mark-external dialog
  const [tab, setTab] = useState<'agreements' | 'pipeline'>('agreements');
  const [markFor, setMarkFor] = useState<AdminAgreement | null>(null);
  const [connectFor, setConnectFor] = useState<AdminAgreement | null>(null);
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

  // Open the signed document in a new tab. Fetched with the auth token, then shown as a blob URL
  // (the endpoint is admin-only, so a bare link wouldn't carry the token).
  const viewAgreement = async (a: AdminAgreement) => {
    try {
      const res = await api.get(`/admin/agreements/${a.id}/view`, { responseType: 'text' });
      const blob = new Blob([res.data as string], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Could not open the agreement');
    }
  };

  // Download the signed PDF, regenerated from the stored snapshot.
  const downloadAgreement = async (a: AdminAgreement) => {
    try {
      const res = await api.get(`/admin/agreements/${a.id}/pdf`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data as Blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `ReceptionMate-Agreement-${a.clientName.replace(/[^a-z0-9]+/gi, '-')}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Could not download the PDF');
    }
  };

  const openSend = (a: AdminAgreement) => {
    setSendFor(a);
    // Default to whoever it went to last, else the account holder — resending after a bounce
    // shouldn't make staff retype the corrected address.
    setSendEmail(a.sentToEmail || a.user.email);
    setSendSms('');
    setSendError(null);
  };

  const submitSend = async () => {
    if (!sendFor) return;
    setBusyId(sendFor.id);
    setSendError(null);
    try {
      const body: { toEmail?: string; toSms?: string } = {};
      // Only send toEmail when it actually differs — keeps the common case on the server default.
      if (sendEmail.trim() && sendEmail.trim() !== sendFor.user.email) body.toEmail = sendEmail.trim();
      if (sendSms.trim()) body.toSms = sendSms.trim();
      const res = await api.post(`/admin/agreements/${sendFor.id}/send`, body);
      // The email is the delivery that counts; a failed text is reported, not fatal.
      if (res.data?.smsError) alert(res.data.smsError);
      setSendFor(null);
      await load();
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } } };
      setSendError(e.response?.data?.error || 'Failed to send');
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

      <div className="flex gap-1 border-b border-slate-200">
        {([
          ['agreements', 'Agreements'],
          ['pipeline', 'Onboarding pipeline'],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={
              tab === key
                ? 'border-b-2 border-brand-600 px-4 py-2 text-sm font-semibold text-brand-700'
                : 'border-b-2 border-transparent px-4 py-2 text-sm font-medium text-slate-500 hover:text-slate-700'
            }
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'pipeline' ? <OnboardingPipeline /> : null}

      <div className={tab === 'agreements' ? 'flex flex-wrap items-center gap-3' : 'hidden'}>
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

      <div className={tab === 'agreements' ? 'overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm' : 'hidden'}>
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr>
              <Th>Client</Th>
              <Th>Email</Th>
              <Th>Status</Th>
              <Th>Viewed</Th>
              <Th>Terms</Th>
              <Th>Signed</Th>
              <Th>Created</Th>
              <Th>Actions</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-sm text-slate-500">
                  Loading…
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-sm text-slate-500">
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
                    {a.firstViewedAt ? (
                      <div>
                        <div className="font-medium text-emerald-700">
                          Opened {sinceLabel(a.firstViewedAt)}
                        </div>
                        <div className="text-xs text-slate-500">
                          {shortDateTime(a.firstViewedAt)}
                          {a.viewCount > 1 ? ` · ${a.viewCount}×` : ''}
                          {a.viewedFromIp ? ` · ${a.viewedFromIp}` : ''}
                        </div>
                      </div>
                    ) : a.status === 'sent' ? (
                      <div>
                        <div className="font-medium text-amber-700">Not opened yet</div>
                        <div className="text-xs text-slate-500">
                          {a.sentAt ? `sent ${sinceLabel(a.sentAt)}` : 'sent date unknown'}
                        </div>
                      </div>
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </Td>
                  <Td>
                    {(() => {
                      // The deal can carry two licences at different per-branch prices, across
                      // several branches. Show what it's worth per month, then how it's made up —
                      // this used to show the voice fee alone and understate every Connect deal.
                      const messaging = a.messagingFeeGbp ?? 0;
                      const perBranch = a.licenceFeeGbp + messaging;
                      const monthly = perBranch * a.centresCount;
                      return (
                        <>
                          <div className="font-medium text-slate-900">{formatGbp(monthly)}/mo</div>
                          <div className="text-xs text-slate-500">
                            {formatGbp(perBranch)}/branch
                            {a.centresCount > 1 ? ` × ${a.centresCount} branches` : ''}
                          </div>
                          {messaging > 0 ? (
                            <div className="text-xs text-slate-500">
                              {formatGbp(a.licenceFeeGbp)} voice + {formatGbp(messaging)} Connect
                            </div>
                          ) : null}
                          <div className="text-xs text-slate-500">
                            {a.setupFeeGbp > 0 ? `Setup ${formatGbp(a.setupFeeGbp)}` : 'No setup fee'}
                          </div>
                        </>
                      );
                    })()}
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
                      <button
                        onClick={() => viewAgreement(a)}
                        className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                      >
                        View
                      </button>
                      {a.licences.includes('automate') && (
                        <button
                          onClick={() => setConnectFor(a)}
                          className="rounded-md border border-indigo-300 bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-100"
                        >
                          Connect GarageHive
                        </button>
                      )}
                      {(a.status === 'signed' || a.status === 'externally_signed') && (
                        <button
                          onClick={() => downloadAgreement(a)}
                          className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                        >
                          Download PDF
                        </button>
                      )}
                      {(a.status === 'draft' || a.status === 'sent') && (
                        <>
                          <button
                            onClick={() => openSend(a)}
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

      {sendFor ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
            <h2 className="text-lg font-semibold text-slate-900">
              {sendFor.status === 'sent' ? 'Resend agreement' : 'Send agreement'}
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              <strong>{sendFor.clientName}</strong> · £{sendFor.licenceFeeGbp}/mo. The link is valid for
              14&nbsp;days; sending again replaces any previous link.
            </p>

            <div className="mt-4 space-y-3">
              <div>
                <label className="block text-xs font-medium uppercase tracking-wide text-slate-600">
                  Send to
                </label>
                <input
                  type="email"
                  value={sendEmail}
                  onChange={(e) => setSendEmail(e.target.value)}
                  className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
                />
                {sendEmail.trim() && sendEmail.trim() !== sendFor.user.email ? (
                  <p className="mt-1 text-xs text-amber-700">
                    Different to the portal login ({sendFor.user.email}). Whoever opens this link can sign
                    for {sendFor.clientName} — their address is recorded on the signed PDF. The login itself
                    is unchanged.
                  </p>
                ) : (
                  <p className="mt-1 text-xs text-slate-500">The portal account holder.</p>
                )}
              </div>

              <div>
                <label className="block text-xs font-medium uppercase tracking-wide text-slate-600">
                  Also text it to <span className="normal-case text-slate-400">(optional)</span>
                </label>
                <input
                  type="tel"
                  value={sendSms}
                  onChange={(e) => setSendSms(e.target.value)}
                  placeholder="07700 900123"
                  className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
                />
                <p className="mt-1 text-xs text-slate-500">
                  Texts the same link. The email is sent either way.
                </p>
              </div>

              {sendError ? (
                <div className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700">{sendError}</div>
              ) : null}
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setSendFor(null)}
                className="rounded-md px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100"
              >
                Cancel
              </button>
              <button
                onClick={submitSend}
                disabled={busyId === sendFor.id || !sendEmail.trim()}
                className="rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
              >
                {busyId === sendFor.id ? 'Sending…' : sendSms.trim() ? 'Send email + text' : 'Send email'}
              </button>
            </div>
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

      {connectFor ? (
        <ConnectGarageHiveModal
          agreementId={connectFor.id}
          clientName={connectFor.clientName}
          onClose={() => setConnectFor(null)}
        />
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
