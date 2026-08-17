'use client';

// End-of-day reports for the ops task board.
//
// Each row is a snapshot written by the 21:00 cron (backend/src/services/opsDailyReport.ts) and
// emailed to staff. Snapshots, not live queries — a past report keeps saying what was true that
// day even after tasks are renamed, reassigned or deleted.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { fetchOpsReports, runOpsReport, type OpsDailyReport } from '@/app/lib/api';

function prettyDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

export default function OpsReportsPage() {
  const [reports, setReports] = useState<OpsDailyReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openDate, setOpenDate] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetchOpsReports();
      setReports(res.reports);
      setOpenDate((cur) => cur ?? res.reports[0]?.reportDate ?? null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load reports');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleRunNow = async () => {
    setRunning(true);
    setError(null);
    try {
      await runOpsReport();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to run report');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl px-4 py-6">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Daily reports</h1>
          <p className="mt-1 text-sm text-slate-600">
            Written automatically at 9pm each evening and emailed to staff.{' '}
            <Link href="/admin/tasks" className="text-blue-600 hover:underline">Back to the board</Link>
          </p>
        </div>
        <button
          type="button"
          onClick={handleRunNow}
          disabled={running}
          className="flex-shrink-0 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {running ? 'Running…' : "Run today's now"}
        </button>
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      )}

      {loading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : reports.length === 0 ? (
        <div className="rounded-md border border-slate-200 bg-white px-4 py-6 text-sm text-slate-600">
          No reports yet — the first one lands at 9pm tonight. You can also generate today&apos;s now
          with the button above.
        </div>
      ) : (
        <ul className="space-y-2">
          {reports.map((r) => {
            const isOpen = openDate === r.reportDate;
            const people = Object.entries(r.totals?.byPerson ?? {});
            return (
              <li key={r.id} className="overflow-hidden rounded-md border border-slate-200 bg-white">
                <button
                  type="button"
                  onClick={() => setOpenDate(isOpen ? null : r.reportDate)}
                  className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-slate-50"
                >
                  <span>
                    <span className="text-sm font-medium text-slate-900">{prettyDate(r.reportDate)}</span>
                    <span className="ml-2 text-xs text-slate-500">
                      {r.totals?.completed ?? 0} done · {r.totals?.outstanding ?? 0} open
                      {people.length > 0 && ` · ${people.map(([n, c]) => `${n} ${c}`).join(', ')}`}
                      {!r.emailedAt && ' · not emailed'}
                    </span>
                  </span>
                  <span className="text-slate-400">{isOpen ? '▲' : '▼'}</span>
                </button>

                {isOpen && (
                  <div className="border-t border-slate-200 px-4 py-3 text-sm">
                    <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Completed</h3>
                    {r.completed?.length ? (
                      <ul className="mb-4 space-y-1">
                        {r.completed.map((c, i) => (
                          <li key={i} className="text-slate-800">
                            <span className="text-slate-400">{c.at}</span>{' '}
                            {c.title}{' '}
                            <span className="text-slate-500">— {c.by}</span>
                            {c.notes && <div className="pl-10 text-xs italic text-slate-500">{c.notes}</div>}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mb-4 text-slate-500">Nothing was ticked off.</p>
                    )}

                    <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Still outstanding</h3>
                    {r.outstanding?.length ? (
                      <ul className="mb-4 space-y-1">
                        {r.outstanding.map((o, i) => (
                          <li key={i} className="text-slate-800">
                            {o.title}{' '}
                            <span className="text-slate-500">({o.cadence}) — {o.assignees}</span>
                            {o.dueDate && <span className="text-amber-700"> · due {o.dueDate}</span>}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mb-4 text-slate-500">Nothing outstanding.</p>
                    )}

                    {r.notes?.length > 0 && (
                      <>
                        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Notes added</h3>
                        <ul className="space-y-1">
                          {r.notes.map((n, i) => (
                            <li key={i} className="text-slate-800">
                              <span className="font-medium">{n.title}</span>{' '}
                              <span className="text-slate-600">— {n.note}</span>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
