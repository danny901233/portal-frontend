'use client';

// Is every garage actually working? Rendered on the Admin page.
//
// It lives here rather than under Observability because of what you do next: a row that says
// "no calls for 65 days" is answered by ringing the customer or checking their forwarding, and
// this is the page with the garages and the buttons on it. Observability answers a different
// question — why the agent is slow — and you act on that by changing config, not by phoning
// anyone.
//
// Built after a review turned up four paying customers who had never received a single call —
// one of them invoiced twice — plus three more whose calls had quietly stopped. All were found by
// accident while looking at something else. This is the screen that would have shown them on day
// one. Worst first, so it opens on whatever is most wrong.

import { useEffect, useState } from 'react';
import api from '../lib/api';

interface Row {
  id: string; name: string; isTest: boolean; monthly: number; number: string | null;
  agentType: string | null; faqCount: number; callsThisMonth: number;
  conversationsThisMonth: number; daysSinceCall: number | null; daysSincePaid: number | null;
  setupComplete: boolean; accessRestricted: boolean; leavingOn: string | null;
  issues: string[]; severity: number;
}

export default function GarageHealth() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hideTests, setHideTests] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        // The shared client attaches the auth token; hand-rolling a fetch here is what produced
        // "no token" — it read localStorage under the wrong key.
        const { data } = await api.get('/api/admin/health');
        setRows(data.garages);
      } catch {
        setError('Could not load the report');
      }
    })();
  }, []);

  const shown = (rows ?? []).filter((r) => !hideTests || !r.isTest);
  const silentPayers = shown.filter((r) => r.monthly > 0 && r.daysSinceCall === null && r.number);
  const wentQuiet = shown.filter((r) => r.monthly > 0 && r.daysSinceCall !== null && r.daysSinceCall > 14);
  const atRisk = silentPayers.reduce((n, r) => n + r.monthly, 0)
    + wentQuiet.reduce((n, r) => n + r.monthly, 0);

  return (
    <div className="mt-10 space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-slate-900">Garage health</h2>
        <p className="mt-1 text-sm text-slate-600">
          Every live garage, worst first. A paying customer receiving nothing sorts to the top.
        </p>
      </div>

      {error && <p className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
      {!rows && !error && <p className="text-sm text-slate-500">Checking every garage…</p>}

      {rows && (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <Stat label="Paying, never had a call" value={String(silentPayers.length)} tone="bad" />
            <Stat label="Paying, gone quiet 14d+" value={String(wentQuiet.length)} tone="warn" />
            <Stat label="Monthly revenue affected" value={`£${atRisk.toLocaleString()}`} tone={atRisk > 0 ? 'bad' : 'ok'} />
          </div>

          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={hideTests} onChange={(e) => setHideTests(e.target.checked)} />
            Hide test accounts
          </label>

          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Garage</th>
                  <th className="px-4 py-3">£/mo</th>
                  <th className="px-4 py-3">Calls 30d</th>
                  <th className="px-4 py-3">Last call</th>
                  <th className="px-4 py-3">Chats 30d</th>
                  <th className="px-4 py-3">FAQs</th>
                  <th className="px-4 py-3">Last paid</th>
                  <th className="px-4 py-3">What&apos;s wrong</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {shown.map((r) => (
                  <tr key={r.id} className={r.severity >= 100 ? 'bg-rose-50/60' : r.severity >= 60 ? 'bg-amber-50/50' : ''}>
                    <td className="px-4 py-3 font-medium text-slate-900">
                      {r.name}
                      {r.leavingOn && (
                        <span className="ml-2 rounded bg-slate-200 px-1.5 py-0.5 text-xs text-slate-600">
                          leaving {new Date(r.leavingOn).toLocaleDateString('en-GB')}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-slate-700">{r.monthly ? `£${r.monthly}` : '—'}</td>
                    <td className="px-4 py-3 text-slate-700">{r.callsThisMonth}</td>
                    <td className={`px-4 py-3 ${r.daysSinceCall === null ? 'font-semibold text-rose-700' : r.daysSinceCall > 14 ? 'text-amber-700' : 'text-slate-600'}`}>
                      {r.daysSinceCall === null ? 'never' : `${r.daysSinceCall}d ago`}
                    </td>
                    <td className="px-4 py-3 text-slate-700">{r.conversationsThisMonth}</td>
                    <td className={`px-4 py-3 ${r.faqCount === 0 ? 'text-amber-700' : 'text-slate-600'}`}>{r.faqCount}</td>
                    <td className="px-4 py-3 text-slate-600">
                      {r.daysSincePaid === null ? '—' : `${r.daysSincePaid}d ago`}
                    </td>
                    <td className="px-4 py-3 text-slate-600">{r.issues.join('; ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone: 'ok' | 'warn' | 'bad' }) {
  const colour = tone === 'bad' ? 'text-rose-700' : tone === 'warn' ? 'text-amber-700' : 'text-emerald-700';
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${colour}`}>{value}</div>
    </div>
  );
}
