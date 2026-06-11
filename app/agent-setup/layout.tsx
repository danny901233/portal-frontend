'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { cn } from '../lib/utils';

interface NavItem {
  href: string;
  label: string;
  description: string;
  staffOnly?: boolean;
}

const NAV: NavItem[] = [
  { href: '/agent-setup/identity', label: 'Branch identity', description: 'Name, contact, address' },
  { href: '/agent-setup/voice', label: 'Voice & sound', description: 'How the agent sounds' },
  { href: '/agent-setup/behavior', label: 'Behavior & rules', description: 'Greeting, tone, rules' },
  { href: '/agent-setup/hours', label: 'Opening hours', description: 'When the agent answers' },
  { href: '/agent-setup/capture', label: 'Information capture', description: 'What to ask callers' },
  { href: '/agent-setup/booking', label: 'Booking behavior', description: 'How bookings are handled' },
  { href: '/agent-setup/integrations', label: 'Integrations', description: 'Diary + CRM' },
  { href: '/agent-setup/routing', label: 'Routing', description: 'Agent assignment', staffOnly: true },
];

export default function AgentSetupLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  // TODO: pull isStaff from session — for now show all; the staff-only items
  // are also gated server-side via backend role checks
  const isStaff = true;
  const visible = NAV.filter((n) => !n.staffOnly || isStaff);

  return (
    <div className="flex min-h-screen bg-slate-950 text-slate-100">
      {/* Secondary nav — mirrors Jodie's "Agent Setup" sub-items pane */}
      <aside className="w-64 shrink-0 border-r border-slate-800 bg-slate-950/60 px-3 py-6">
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
                    ? 'bg-sky-500 text-white shadow-lg shadow-sky-500/20'
                    : 'text-slate-300 hover:bg-slate-800 hover:text-slate-100',
                )}
              >
                <div className="font-medium">{item.label}</div>
                <div
                  className={cn(
                    'mt-0.5 text-xs',
                    isActive ? 'text-sky-100' : 'text-slate-500',
                  )}
                >
                  {item.description}
                </div>
              </Link>
            );
          })}
        </nav>
      </aside>

      {/* Main page content */}
      <main className="flex-1 px-8 py-8">
        <div className="mx-auto max-w-3xl">{children}</div>
      </main>
    </div>
  );
}
