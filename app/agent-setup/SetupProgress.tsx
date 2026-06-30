'use client';

import Link from 'next/link';
import type { AgentConfiguration } from '../types';
import { useAgentSetup } from './useAgentSetup';

// Loose completion checks — any meaningful signal in the group counts.
// We want the widget to encourage completion, not police perfection.
type GroupKey = 'basics' | 'voice' | 'bookings' | 'knowledge';

const GROUPS: Array<{ key: GroupKey; label: string; href: string }> = [
  { key: 'basics',    label: 'Basics',                href: '/agent-setup/company-information' },
  { key: 'voice',     label: 'Voice & personality',   href: '/agent-setup/voice' },
  { key: 'bookings',  label: 'Bookings & transfers',  href: '/agent-setup/bookings-transfers' },
  { key: 'knowledge', label: 'Knowledge',             href: '/agent-setup/questions' },
];

function isComplete(config: AgentConfiguration, group: GroupKey): boolean {
  switch (group) {
    case 'basics': {
      const branchOk = (config.branchName ?? '').trim().length > 0;
      const hours = config.weeklyOpeningHours ?? {};
      const hoursOk = Object.values(hours).some(
        (d) => d && typeof d === 'object' && !!(d as { open?: string }).open && !!(d as { close?: string }).close,
      );
      return branchOk && hoursOk;
    }
    case 'voice': {
      const greetingOk = (config.greetingLine ?? '').trim().length > 0;
      const voiceOk = !!config.voice;
      return greetingOk && voiceOk;
    }
    case 'bookings': {
      const transferOk = (config.transferNumber ?? '').trim().length > 0;
      return transferOk || !!config.allowBookings;
    }
    case 'knowledge': {
      const r = (config.customRules ?? []) as unknown[];
      const d = (config.dataCollectionFields ?? []) as unknown[];
      const f = (config.faqs ?? []) as unknown[];
      const p = (config.pronunciations ?? []) as unknown[];
      return r.length > 0 || d.length > 0 || f.length > 0 || p.length > 0;
    }
  }
}

export default function SetupProgress() {
  const { config, isLoading } = useAgentSetup();
  if (isLoading || !config) return null;

  const statuses = GROUPS.map((g) => ({ ...g, done: isComplete(config, g.key) }));
  const completed = statuses.filter((s) => s.done).length;
  const total = GROUPS.length;
  const pct = Math.round((completed / total) * 100);
  const allDone = completed === total;

  return (
    <div className="mx-3 mb-4 rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm">
      <div className="flex items-center gap-2.5">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
          <RocketIcon />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-slate-900">
              {allDone ? 'Setup complete' : 'Setup'}
            </span>
            <span className="text-xs font-medium tabular-nums text-slate-500">
              {completed}/{total}
            </span>
          </div>
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
            <div
              className={`h-full transition-all duration-500 ${allDone ? 'bg-emerald-500' : 'bg-brand-600'}`}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      </div>

      <ul className="mt-3 space-y-1">
        {statuses.map((s) => (
          <li key={s.key}>
            <Link
              href={s.href}
              className="group flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-slate-50"
            >
              <CheckDot done={s.done} />
              <span
                className={
                  s.done
                    ? 'text-xs text-slate-500'
                    : 'text-xs font-medium text-slate-700 group-hover:text-slate-900'
                }
              >
                {s.label}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RocketIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/>
      <path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/>
      <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/>
      <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>
    </svg>
  );
}

function CheckDot({ done }: { done: boolean }) {
  if (done) {
    return (
      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </span>
    );
  }
  return <span className="h-4 w-4 shrink-0 rounded-full border-2 border-slate-300" />;
}
