'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { cn } from '../lib/utils';
import { isReceptionMateStaff } from '../lib/auth';
import SetupProgress from './SetupProgress';
import TourBanner from './TourBanner';
import { AGENT_SETUP_NAV } from './_nav';

export default function AgentSetupLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const isStaff = isReceptionMateStaff();
  const visible = AGENT_SETUP_NAV.filter((n) => !n.staffOnly || isStaff);

  return (
    <div className="flex min-h-screen bg-white text-slate-900">
      <aside className="w-64 shrink-0 border-r border-slate-200 bg-slate-50 px-3 py-6">
        <SetupProgress />
        <div className="px-3 pb-4">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Agent Setup
          </h2>
          <p className="mt-1 text-xs text-slate-600">
            Configure this garage&rsquo;s AI agent. Changes apply on next call.
          </p>
        </div>
        <nav className="space-y-1">
          {visible.map((item) => {
            const isActive = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'block rounded-lg px-3 py-2 text-sm transition',
                  isActive
                    ? 'bg-brand-600 text-white shadow-lg shadow-brand-600/20'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
                )}
              >
                <div className="font-medium">{item.label}</div>
                <div
                  className={cn(
                    'mt-0.5 text-xs',
                    isActive ? 'text-brand-700' : 'text-slate-500',
                  )}
                >
                  {item.description}
                </div>
              </Link>
            );
          })}
        </nav>
      </aside>

      <main className="flex-1 px-8 py-8">
        <TourBanner />
        <div className="mx-auto max-w-3xl">{children}</div>
      </main>
    </div>
  );
}
