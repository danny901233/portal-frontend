'use client';

import { useCallback, useEffect, useState } from 'react';
import api from '../../lib/api';

// Phase 4: what's in flight in the sales-led (Direct Debit) onboarding pipeline, and the buttons
// to push each deal along. Only garages with onboardingStage != 'live' appear — every
// pre-existing garage defaults to 'live', so this stays empty until a deal is onboarded through
// the new flow.

type Stage =
  | 'awaiting_agreement'
  | 'awaiting_credentials'
  | 'agent_built'
  | 'invited'
  | 'mandate_pending'
  | 'live';

interface PipelineRow {
  garageId: string;
  garageName: string;
  businessName: string | null;
  stage: Stage;
  billingMethod: string | null;
  customerEmail: string | null;
  customerUserId: string | null;
  welcomeEmailSentAt: string | null;
  // { "<stage>": "<ISO>" } — when the garage entered each stage.
  onboardingStageAt: Record<string, string> | null;
  hasMandate: boolean;
  agreement: {
    id: string;
    status: string;
    licences: string[];
    licenceFeeGbp: number;
    signedAt: string | null;
    sentAt: string | null;
    sentToEmail: string | null;
    firstViewedAt: string | null;
    lastViewedAt: string | null;
    viewCount: number;
  } | null;
  agentType: string | null;
  agentScript: string | null;
  integrationProvider: string | null;
  ghlOpportunityId: string | null;
  bookingActivation: { done: number; required: number } | null;
  trialEndDate: string | null;
}

// "3d ago" beats a raw timestamp for the question this page answers: is this deal stuck?
function since(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function on(iso: string | null | undefined): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

const STAGE_LABEL: Record<Stage, string> = {
  awaiting_agreement: 'Awaiting signature',
  awaiting_credentials: 'Getting credentials',
  agent_built: 'Agent built',
  invited: 'Invited',
  mandate_pending: 'Awaiting mandate',
  live: 'Live',
};

const STAGE_TONE: Record<Stage, string> = {
  awaiting_agreement: 'bg-slate-100 text-slate-700 ring-slate-200',
  awaiting_credentials: 'bg-amber-50 text-amber-800 ring-amber-200',
  agent_built: 'bg-violet-50 text-violet-700 ring-violet-200',
  invited: 'bg-sky-50 text-sky-700 ring-sky-200',
  mandate_pending: 'bg-orange-50 text-orange-800 ring-orange-200',
  live: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
};

// What staff can do next, per stage. Deliberately one obvious action each — the pipeline is a
// worklist, not a state machine editor.
const NEXT_ACTION: Partial<Record<Stage, { label: string; stage: Stage; hint: string }>> = {
  awaiting_agreement: { label: 'Mark signed', stage: 'awaiting_credentials', hint: 'Signing normally moves this automatically' },
  awaiting_credentials: { label: 'Credentials received', stage: 'agent_built', hint: 'Once GarageHive/Tyresoft have sent them' },
  agent_built: { label: 'Send welcome email', stage: 'invited', hint: 'Emails their login — do this once the agent works' },
};

// axios hides the useful text in err.response.data.error; its own message is just "Request
// failed with status code 409". Our guards explain exactly what happened and what to do instead,
// so always prefer the server's.
function serverError(err: unknown, fallback: string) {
  const e = err as { response?: { data?: { error?: string } }; message?: string };
  return e?.response?.data?.error || e?.message || fallback;
}

export default function OnboardingPipeline() {
  const [rows, setRows] = useState<PipelineRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const { data } = await api.get<{ rows: PipelineRow[] }>('/admin/onboarding-pipeline');
      setRows(data.rows ?? []);
      setError(null);
    } catch (err) {
      setError(serverError(err, 'Failed to load the pipeline'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const move = async (row: PipelineRow, stage: Stage) => {
    setBusy(row.garageId);
    try {
      await api.post(`/admin/garages/${row.garageId}/stage`, { stage });
      await load();
    } catch (err) {
      alert(serverError(err, 'Failed to move the deal'));
    } finally {
      setBusy(null);
    }
  };

  const invite = async (row: PipelineRow) => {
    if (!confirm(`Email ${row.customerEmail} their login for ${row.garageName}?\n\nThis generates a new password and lets them into the portal. Only do this once the agent is actually ready.`)) return;
    setBusy(row.garageId);
    try {
      await api.post(`/admin/garages/${row.garageId}/invite`, {});
      await load();
    } catch (err) {
      alert(serverError(err, 'Failed to send the invite'));
    } finally {
      setBusy(null);
    }
  };

  const chaseDd = async (row: PipelineRow) => {
    if (!row.customerUserId) return;
    setBusy(row.garageId);
    try {
      await api.post(`/admin/request-direct-debit/${row.customerUserId}`, {});
      alert(`Direct Debit setup link emailed to ${row.customerEmail}.`);
    } catch (err) {
      alert(serverError(err, 'Failed to send the Direct Debit request'));
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <p className="text-sm text-slate-500">Loading pipeline…</p>;

  if (error) {
    return <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>;
  }

  if (!rows.length) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center">
        <p className="text-sm font-medium text-slate-700">No deals in onboarding</p>
        <p className="mt-1 text-xs text-slate-500">
          Sales-led deals appear here once they&rsquo;re onboarded with &ldquo;Email sign link to customer&rdquo; ticked.
          Existing garages are already live and never show up.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {rows.map((row) => {
        const next = NEXT_ACTION[row.stage];
        const isBusy = busy === row.garageId;
        return (
          <div key={row.garageId} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="truncate text-sm font-semibold text-slate-900">{row.garageName}</h3>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${STAGE_TONE[row.stage]}`}>
                    {STAGE_LABEL[row.stage] ?? row.stage}
                  </span>
                </div>
                <p className="mt-0.5 truncate text-xs text-slate-500">
                  {row.customerEmail ?? <span className="text-rose-600">no customer user</span>}
                  {row.agentType ? ` · ${row.agentType}` : ''}
                  {row.integrationProvider && row.integrationProvider !== 'none' ? ` · ${row.integrationProvider}` : ''}
                  {row.billingMethod ? ` · ${row.billingMethod}` : ''}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {row.stage === 'agent_built' ? (
                  <button
                    onClick={() => invite(row)}
                    disabled={isBusy || !row.customerEmail}
                    className="rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50"
                    title={NEXT_ACTION.agent_built?.hint}
                  >
                    {isBusy ? 'Sending…' : 'Send welcome email'}
                  </button>
                ) : next ? (
                  <button
                    onClick={() => move(row, next.stage)}
                    disabled={isBusy}
                    className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                    title={next.hint}
                  >
                    {isBusy ? 'Saving…' : next.label}
                  </button>
                ) : null}

                {(row.stage === 'invited' || row.stage === 'mandate_pending') && !row.hasMandate && row.customerUserId ? (
                  <button
                    onClick={() => chaseDd(row)}
                    disabled={isBusy}
                    className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
                  >
                    Chase Direct Debit
                  </button>
                ) : null}
              </div>
            </div>

            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-slate-100 pt-3 text-xs sm:grid-cols-4">
              <Fact
                label="Agreement"
                value={
                  row.agreement
                    ? `${row.agreement.status} · £${row.agreement.licenceFeeGbp}/mo${
                        row.agreement.signedAt ? ` · signed ${on(row.agreement.signedAt)}` : ''
                      }`
                    : 'not sent'
                }
                warn={!row.agreement}
              />
              <Fact
                label="Sent"
                value={row.agreement?.sentAt ? `${on(row.agreement.sentAt)} · ${since(row.agreement.sentAt)}` : 'not sent'}
                warn={!row.agreement?.sentAt}
              />
              <Fact
                label="Opened"
                value={
                  row.agreement?.firstViewedAt
                    ? `${since(row.agreement.firstViewedAt)}${row.agreement.viewCount > 1 ? ` · ${row.agreement.viewCount}×` : ''}`
                    : row.agreement?.sentAt
                      ? 'not opened yet'
                      : '—'
                }
                warn={Boolean(row.agreement?.sentAt && !row.agreement?.firstViewedAt)}
              />
              <Fact label="Direct Debit" value={row.hasMandate ? 'mandate live' : 'not set up'} warn={!row.hasMandate} />
              <Fact
                label="Credentials received"
                value={
                  // Stamped when staff clicked "Credentials received", which moves the garage to
                  // agent_built — so that stage's entry time is the click time.
                  row.onboardingStageAt?.agent_built
                    ? `${on(row.onboardingStageAt.agent_built)} · ${since(row.onboardingStageAt.agent_built)}`
                    : 'not yet'
                }
              />
              <Fact
                label="Welcome email"
                value={row.welcomeEmailSentAt ? `${on(row.welcomeEmailSentAt)} · ${since(row.welcomeEmailSentAt)}` : 'not sent'}
              />
              <Fact
                label="HighLevel"
                value={row.ghlOpportunityId ? 'linked' : 'not linked'}
                warn={!row.ghlOpportunityId}
              />
              {row.bookingActivation ? (
                <Fact label="Free until" value={`${row.bookingActivation.done}/${row.bookingActivation.required} bookings`} />
              ) : null}
              {row.trialEndDate ? (
                <Fact label="Trial ends" value={new Date(row.trialEndDate).toLocaleDateString('en-GB')} />
              ) : null}
            </dl>
          </div>
        );
      })}
    </div>
  );
}

function Fact({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className={warn ? 'font-medium text-amber-700' : 'text-slate-700'}>{value}</dd>
    </div>
  );
}
