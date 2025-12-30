'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { Poppins } from 'next/font/google';
import { cn } from '../lib/utils';

const poppins = Poppins({
  subsets: ['latin'],
  weight: ['600'],
  display: 'swap',
});

const baseNavigation = [
  { name: 'Dashboard', href: '/dashboard' },
  { name: 'Calls', href: '/calls' },
  { name: 'Agent Configurations', href: '/agent-configurations' },
];

const adminNavigation = { name: 'Admin', href: '/admin' } as const;

const supportLinks = [{ name: 'Help & Guides', href: '/help' }];

export default function Sidebar({
  activePath,
  showAdminLink = false,
}: {
  activePath: string;
  showAdminLink?: boolean;
}) {
  const items = useMemo(
    () =>
      (showAdminLink ? [...baseNavigation, adminNavigation] : baseNavigation).map((item) => ({
        ...item,
        isActive: activePath.startsWith(item.href),
      })),
    [activePath, showAdminLink],
  );

  const supportItems = useMemo(
    () =>
      supportLinks.map((item) => ({
        ...item,
        isActive: activePath.startsWith(item.href),
      })),
    [activePath],
  );

  return (
    <aside className="flex w-64 flex-col border-r border-slate-800 bg-slate-950/60">
      <div className="flex flex-col items-center justify-center border-b border-slate-800 px-5 py-6 text-center">
        <img
          src="https://storage.googleapis.com/msgsndr/2UadumwHCXxeU9yxBIRC/media/65cf28be6e4392e608cca8a9.png"
          alt="ReceptionMate"
          className="h-24 w-auto"
        />
        <p
          className={cn(
            'mt-3 text-xs font-bold uppercase tracking-[0.12em] text-slate-100',
            poppins.className,
          )}
        >
          <span className="block italic">“Turn Missed Calls Into</span>
          <span className="block italic">New Opportunities”</span>
        </p>
      </div>
      <nav className="flex-1 space-y-1 px-3 py-4">
        {items.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              'flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors',
              item.isActive
                ? 'bg-slate-800/60 text-slate-100'
                : 'text-slate-400 hover:bg-slate-800/40 hover:text-slate-100',
            )}
          >
            <span>{item.name}</span>
          </Link>
        ))}
      </nav>
      <div className="border-t border-slate-800 px-3 py-4">
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
          Help
        </div>
        <div className="space-y-1">
          {supportItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors',
                item.isActive
                  ? 'bg-slate-800/60 text-slate-100'
                  : 'text-slate-400 hover:bg-slate-800/40 hover:text-slate-100',
              )}
            >
              <span>{item.name}</span>
            </Link>
          ))}
        </div>
      </div>
      <div className="border-t border-slate-800 px-5 py-4 text-xs text-slate-500">
        © {new Date().getFullYear()} ReceptionMate
      </div>
    </aside>
  );
}
