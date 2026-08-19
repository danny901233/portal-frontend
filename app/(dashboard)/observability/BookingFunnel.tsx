'use client';

// Of the callers who wanted to book, how many did — and where did the rest fall out?
//
// The stored intent field cannot answer this: it records what a call turned out to be, so a
// caller who wanted to book and gave up is filed as "general enquiry", indistinguishable from
// someone asking the opening hours. Intent is inferred server-side from the tools the agent
// actually reached for.
//
// Shown as a funnel rather than a single number because "43% converted" tells you nothing about
// what to fix. The stage where the line drops is the thing worth working on.

import { useEffect, useState } from 'react';
import api from '../../lib/api';

interface Funnel {
  days: number;
  callsAnalysed: number;
  bookingIntent: number;
  booked: number;
  conversionRate: number;
  funnel: { stage: string; calls: number; pct: number }[];
}

export default function BookingFunnel() {
  const [data, setData] = useState<Funnel | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await api.get('/api/staff/booking-funnel?days=30');
        setData(res.data);
      } catch {
        setError(true);
      }
    })();
  }, []);

  if (error) return null;
  if (!data) return <p className="mt-10 text-sm text-slate-500">Working out booking conversion…</p>;

  return (
    <div className="mt-10">
      <h2 className="text-xl font-semibold text-slate-900">Booking conversion</h2>
      <p className="mt-1 text-sm text-slate-600">
        Callers who asked to book something, and how far they got. Last {data.days} days,{' '}
        {data.callsAnalysed.toLocaleString()} calls.
      </p>

      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <Stat label="Calls with booking intent" value={data.bookingIntent.toLocaleString()} />
        <Stat label="Ended in a booking" value={data.booked.toLocaleString()} />
        <Stat
          label="Conversion"
          value={`${data.conversionRate}%`}
          tone={data.conversionRate >= 60 ? 'good' : data.conversionRate >= 40 ? 'ok' : 'bad'}
        />
      </div>

      <div className="mt-5 space-y-2 rounded-xl border border-slate-200 bg-white p-5">
        {data.funnel.map((f, i) => {
          const prev = i > 0 ? data.funnel[i - 1] : null;
          // The drop from the previous stage is the number worth reading — it says where the
          // conversation is being lost, which the running percentage does not.
          const dropped = prev ? prev.calls - f.calls : 0;
          return (
            <div key={f.stage}>
              <div className="flex items-baseline justify-between text-sm">
                <span className="text-slate-700">{f.stage}</span>
                <span className="tabular-nums text-slate-500">
                  {f.calls.toLocaleString()} · {f.pct}%
                  {dropped > 0 && (
                    <span className="ml-2 text-rose-600">−{dropped.toLocaleString()}</span>
                  )}
                </span>
              </div>
              <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full rounded-full bg-brand-600"
                  style={{ width: `${Math.max(f.pct, 1)}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'ok' | 'bad' }) {
  const colour =
    tone === 'good' ? 'text-emerald-700' : tone === 'bad' ? 'text-rose-700' : tone === 'ok' ? 'text-amber-700' : 'text-slate-900';
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${colour}`}>{value}</div>
    </div>
  );
}
