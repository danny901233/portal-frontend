'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '../lib/utils';
import { useT } from '../i18n/LocaleProvider';

interface Props {
  hasMessagingAccess?: boolean;
  unreadCalls?: number;
  unreadMessages?: number;
  onOpenMore: () => void;
}

/**
 * Mobile-only bottom tab bar. Hidden on md+ (desktop is unchanged). Gives phone
 * users native-style navigation; "More" opens the full sidebar drawer.
 */
export default function MobileBottomNav({
  hasMessagingAccess = false,
  unreadCalls = 0,
  unreadMessages = 0,
  onOpenMore,
}: Props) {
  const pathname = usePathname() ?? '';
  const t = useT();

  const items = [
    { href: '/dashboard', label: t('nav.dashboard'), icon: <DashIcon />, badge: 0 },
    { href: '/calls', label: t('nav.calls'), icon: <PhoneIcon />, badge: unreadCalls },
    ...(hasMessagingAccess
      ? [{ href: '/messages', label: t('nav.messages'), icon: <ChatIcon />, badge: unreadMessages }]
      : []),
  ];

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 flex border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)] shadow-[0_-2px_12px_rgba(15,23,42,0.06)] md:hidden"
      style={{
        paddingLeft: 'env(safe-area-inset-left)',
        paddingRight: 'env(safe-area-inset-right)',
      }}
    >
      {items.map((item) => {
        const active =
          pathname === item.href ||
          pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              'flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-semibold',
              active ? 'text-brand-600' : 'text-slate-500',
            )}
          >
            <span className="relative h-6 w-6">
              {item.icon}
              {item.badge > 0 ? (
                <span className="absolute -right-2 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold leading-none text-white ring-2 ring-white">
                  {item.badge > 99 ? '99+' : item.badge}
                </span>
              ) : null}
            </span>
            <span className="truncate">{item.label}</span>
          </Link>
        );
      })}
      <button
        type="button"
        onClick={onOpenMore}
        className="flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-semibold text-slate-500"
      >
        <span className="h-6 w-6"><MenuIcon /></span>
        <span>{t('nav.more')}</span>
      </button>
    </nav>
  );
}

function DashIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-6 w-6">
      <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}
function PhoneIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-6 w-6">
      <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2 4.2 2 2 0 0 1 4 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7A2 2 0 0 1 22 16.9z" />
    </svg>
  );
}
function ChatIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-6 w-6">
      <path d="M21 11.5a8.4 8.4 0 0 1-9 8 8.4 8.4 0 0 1-3.8-.9L3 20l1.4-5A8.4 8.4 0 0 1 12 3.5a8.4 8.4 0 0 1 9 8z" />
    </svg>
  );
}
function MenuIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-6 w-6">
      <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}
