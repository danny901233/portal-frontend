'use client';

// The sales-led onboarding pipeline board.
//
// The endpoint behind this (GET /admin/onboarding-pipeline) was recovered on 2026-09-09, but the
// page that displayed it had been lost with the rest of the feature — so the data existed and
// there was no way to reach it. Same for the two actions here: moving a stage and linking a
// HighLevel opportunity were both API-only, which meant a deal could only be corrected by
// running a script.
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { isReceptionMateStaff } from '../../lib/auth';
import api from '../../lib/api';

type Agreement = {
  id: string;
  status: string;
  signedAt: string | null;
  sentAt: string | null;
  sentToEmail: string | null;
  firstViewedAt: string | null;
  viewCount: number;
} | null;

type Row = {
  garageId: string;
  garageName: string;
  businessName: string | null;
  stage: string;
  billingMethod: string | null;
  customerEmail: string | null;
  welcomeEmailSentAt: string | null;
  onboardingStageAt: Record<string, string> | null;
  hasMandate: boolean;
  agreement: Agreement;
  agentScript: string | null;
  integrationProvider: string | null;
  ghlOpportunityId: string | null;
  trialEndDate: string | null;
};

const STAGE_LABEL: Record<string, string> = {
  awaiting_agreement: 'Awaiting agreement',
  awaiting_credentials: 'Awaiting credentials',
  agent_built: 'Agent built',
  invited: 'Invited — awaiting mandate',
  mandate_pending: 'Mandate pending',
  live: 'Live',
};

const fmt = (d: string | null) =>
  d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '—';

export default function AdminPipelinePage() {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>([]);
  const [stages, setStages] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [linkFor, setLinkFor] = useState<Row | null>(null);
  const [linkValue, setLinkValue] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await api.get<{ stages: string[]; rows: Row[] }>('/admin/onboarding-pipeline');
      setRows(data.rows ?? []);
      setStages(data.stages ?? []);
    } catch {
      setError('Could not load the pipeline.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isReceptionMateStaff()) {
      router.replace('/');
      return;
    }
    void load();
  }, [load, router]);

  const moveStage = async (r: Row, stage: string) => {
    setBusy(r.garageId);
    try {
      await api.post(`/admin/garages/${r.garageId}/stage`, { stage });
      await load();
    } catch (e: any) {
      setError(e?.response?.data?.error ?? 'Could not move that deal.');
    } finally {
      setBusy(null);
    }
  };

  const invite = async (r: Row) => {
    if (!confirm(`Send ${r.customerEmail} their login for ${r.garageName}?`)) return;
    setBusy(r.garageId);
    try {
      await api.post(`/admin/garages/${r.garageId}/invite`);
      await load();
    } catch (e: any) {
      setError(e?.response?.data?.error ?? 'Could not send the invite.');
    } finally {
      setBusy(null);
    }
  };

  const saveLink = async () => {
    if (!linkFor) return;
    setBusy(linkFor.garageId);
    try {
      await api.patch(`/admin/garages/${linkFor.garageId}/highlevel`, {
        ghlOpportunityId: linkValue.trim() || null,
      });
      setLinkFor(null);
      await load();
    } catch (e: any) {
      setError(e?.response?.data?.error ?? 'Could not save that link.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Onboarding pipeline</h1>
          <p className="mt-1 text-sm text-slate-600">
            Sales-led deals between signing and going live. Garages that are already live are not
            listed.
          </p>
        </div>
        <button
          onClick={() => void load()}
          className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Refresh
        </button>
      </div>

      {error ? <p className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}

      {loading ? (
        <p className="mt-8 text-sm text-slate-500">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="mt-8 rounded-xl border border-slate-200 bg-white p-8 text-center">
          <p className="text-sm text-slate-600">Nothing in the pipeline.</p>
          <p className="mt-1 text-xs text-slate-500">
            A deal appears here once it is onboarded with an agreement, and leaves when the Direct
            Debit mandate completes.
          </p>
        </div>
      ) : (
        <div className="mt-6 space-y-6">
          {stages
            .filter((s) => s !== 'live' && rows.some((r) => r.stage === s))
            .map((stage) => (
              <section key={stage}>
                <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                  {STAGE_LABEL[stage] ?? stage}{' '}
                  <span className="text-slate-400">({rows.filter((r) => r.stage === stage).length})</span>
                </h2>
                <div className="mt-2 space-y-2">
                  {rows
                    .filter((r) => r.stage === stage)
                    .map((r) => (
                      <div
                        key={r.garageId}
                        className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="font-medium text-slate-900">{r.garageName}</p>
                            <p className="text-xs text-slate-500">
                              {r.businessName ?? '—'} · {r.customerEmail ?? 'no customer user'}
                            </p>
                            <p className="mt-1 text-xs text-slate-500">
                              {r.agentScript ?? 'no agent'} · {r.integrationProvider ?? 'no diary'} ·{' '}
                              {r.billingMethod ?? 'no billing method'}
                            </p>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            {/* What is actually outstanding, at a glance. */}
                            <Chip ok={r.agreement?.status === 'signed' || r.agreement?.status === 'externally_signed'}>
                              {r.agreement
                                ? r.agreement.status === 'signed' || r.agreement.status === 'externally_signed'
                                  ? `signed ${fmt(r.agreement.signedAt)}`
                                  : r.agreement.firstViewedAt
                                  ? `sent ${fmt(r.agreement.sentAt)}, opened`
                                  : `sent ${fmt(r.agreement.sentAt)}, not opened`
                                : 'no agreement'}
                            </Chip>
                            <Chip ok={!!r.welcomeEmailSentAt}>
                              {r.welcomeEmailSentAt ? `login sent ${fmt(r.welcomeEmailSentAt)}` : 'login not sent'}
                            </Chip>
                            <Chip ok={r.hasMandate}>{r.hasMandate ? 'mandate' : 'no mandate'}</Chip>
                            <Chip ok={!!r.ghlOpportunityId}>
                              {r.ghlOpportunityId ? 'HL linked' : 'HL not linked'}
                            </Chip>
                          </div>
                        </div>

                        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
                          <select
                            value={r.stage}
                            disabled={busy === r.garageId}
                            onChange={(e) => void moveStage(r, e.target.value)}
                            className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-700"
                          >
                            {stages.map((s) => (
                              <option key={s} value={s}>
                                {STAGE_LABEL[s] ?? s}
                              </option>
                            ))}
                          </select>
                          <button
                            onClick={() => {
                              setLinkFor(r);
                              setLinkValue(r.ghlOpportunityId ?? '');
                            }}
                            className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                          >
                            {r.ghlOpportunityId ? 'Change HighLevel link' : 'Link HighLevel'}
                          </button>
                          {!r.welcomeEmailSentAt && r.customerEmail ? (
                            <button
                              onClick={() => void invite(r)}
                              disabled={busy === r.garageId}
                              className="rounded-md border border-brand-600 bg-white px-2.5 py-1 text-xs font-medium text-brand-600 hover:bg-brand-50 disabled:opacity-50"
                            >
                              Send login
                            </button>
                          ) : null}
                        </div>
                      </div>
                    ))}
                </div>
              </section>
            ))}
        </div>
      )}

      {linkFor ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
            <h2 className="text-lg font-semibold text-slate-900">HighLevel opportunity</h2>
            <p className="mt-1 text-sm text-slate-600">
              For <strong>{linkFor.garageName}</strong>. Linking lets stage changes here move the
              deal in HighLevel. Clear it to unlink.
            </p>
            <input
              value={linkValue}
              onChange={(e) => setLinkValue(e.target.value)}
              placeholder="Opportunity ID"
              className="mt-4 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-brand-600 focus:outline-none"
            />
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setLinkFor(null)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                onClick={() => void saveLink()}
                disabled={busy === linkFor.garageId}
                className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Chip({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <span
      className={
        'rounded-full px-2 py-0.5 text-xs font-medium ' +
        (ok ? 'bg-green-100 text-green-800' : 'bg-slate-100 text-slate-600')
      }
    >
      {children}
    </span>
  );
}
