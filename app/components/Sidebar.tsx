'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../lib/utils';
import { fetchAgentConfiguration } from '../lib/api';
import { AGENT_SETUP_NAV, type AgentSetupNavItem } from '../agent-setup/_nav';
import { isReceptionMateStaff } from '../lib/auth';
import { useT, useLang } from '../i18n/LocaleProvider';
import LanguageToggle from './LanguageToggle';

const AGENT_SETUP_NAV_FR: Record<string, { label: string; description: string }> = {
  '/agent-setup/company-information': {
    label: 'Informations sur l’entreprise',
    description: 'Nom, contact, adresse de l’établissement',
  },
  '/agent-setup/opening-hours': {
    label: 'Horaires d’ouverture',
    description: 'Quand l’agent répond',
  },
  '/agent-setup/voice': {
    label: 'Identité, voix et accueil',
    description: 'Voix de l’agent + première phrase + prononciations',
  },
  '/agent-setup/questions': {
    label: 'Questions intelligentes et FAQ',
    description: 'Quoi demander + questions/réponses courantes',
  },
  '/agent-setup/rules': {
    label: 'Règles',
    description: 'Règles personnalisées que l’agent doit suivre',
  },
  '/agent-setup/bookings-transfers': {
    label: 'Réservations et transferts',
    description: 'Comportement de réservation + où diriger les appels',
  },
  '/agent-setup/messaging': {
    label: 'Messagerie',
    description: "Comportement de l'agent de chat + canaux connectés",
  },
  '/agent-setup/training': {
    label: 'Formation',
    description: 'Apprenez-en à l’agent sur vous',
  },
  '/agent-setup/notifications': {
    label: 'Notifications',
    description: 'Qui reçoit un e-mail après un appel',
  },
  '/agent-setup/integrations': {
    label: 'Intégrations',
    description: 'HubSpot',
  },
  '/agent-setup/routing': {
    label: 'Routage',
    description: 'Attribution de l’agent',
  },
};

interface NavItem {
  name: string;
  /** i18n key resolved via useT(); falls back to `name` if missing. */
  tKey?: string;
  href: string;
  icon: React.ReactNode;
  requiresMessaging?: boolean;
  requiresManager?: boolean;
  requiresStaff?: boolean;
}

const baseNavigation: NavItem[] = [
  { name: 'Dashboard', tKey: 'nav.dashboard', href: '/dashboard', icon: <DashboardIcon /> },
  { name: 'Calls', tKey: 'nav.calls', href: '/calls', icon: <PhoneIcon /> },
  { name: 'Messages', tKey: 'nav.messages', href: '/messages', icon: <ChatIcon /> },
  { name: 'Outbound', tKey: 'nav.outbound', href: '/outbound', icon: <SendIcon />, requiresMessaging: true },
  { name: 'Templates', tKey: 'nav.templates', href: '/templates', icon: <TemplateIcon />, requiresMessaging: true },
  { name: 'Agent Configurations', tKey: 'nav.agentConfigurations', href: '/agent-configurations', icon: <CogIcon />, requiresManager: true },
  { name: 'Team', tKey: 'nav.team', href: '/team', icon: <UsersIcon />, requiresManager: true },
  { name: 'Observability', tKey: 'nav.observability', href: '/observability', icon: <ChartIcon />, requiresStaff: true },
  { name: 'Billing', tKey: 'nav.billing', href: '/billing', icon: <BillingIcon /> },
];

const adminNavigation: NavItem = { name: 'Admin', tKey: 'nav.admin', href: '/admin', icon: <ShieldIcon /> };

const supportLinks: NavItem[] = [{ name: 'Help & Guides', tKey: 'nav.helpGuides', href: '/help', icon: <HelpIcon /> }];

interface SidebarProps {
  activePath: string;
  garageId?: string | null;
  showAdminLink?: boolean;
  hasMessagingAccess?: boolean;
  hasManagerAccess?: boolean;
  isManagerUser?: boolean;
  messagesNeedingAttention?: number;
}

export default function Sidebar({
  activePath,
  garageId,
  showAdminLink = false,
  hasMessagingAccess = false,
  hasManagerAccess = false,
  isManagerUser = false,
  messagesNeedingAttention = 0,
}: SidebarProps) {
  const t = useT();
  const items = useMemo(() => {
    const filteredBase = baseNavigation.filter((item) => {
      if (item.href === '/messages') return hasMessagingAccess;
      if (item.href === '/billing') return hasManagerAccess;
      // Branch-managers (MANAGER branch-role, global role USER) are managers of their
      // own garage — show them the manager items too, matching how Billing gates.
      if (item.requiresManager) return isManagerUser || hasManagerAccess;
      if (item.requiresMessaging) return hasMessagingAccess;
      if (item.requiresStaff) return showAdminLink;
      return true;
    });

    return (showAdminLink ? [...filteredBase, adminNavigation] : filteredBase).map((item) => ({
      ...item,
      isActive: activePath.startsWith(item.href),
    }));
  }, [activePath, showAdminLink, hasMessagingAccess, hasManagerAccess, isManagerUser]);

  const supportItems = useMemo(
    () =>
      supportLinks.map((item) => ({
        ...item,
        isActive: activePath.startsWith(item.href),
      })),
    [activePath],
  );

  // Pull the current garage's Twilio number for the bottom "Your number" card.
  const [twilioNumber, setTwilioNumber] = useState<string | null>(null);
  useEffect(() => {
    if (!garageId) {
      setTwilioNumber(null);
      return;
    }
    let cancelled = false;
    fetchAgentConfiguration(garageId)
      .then((res) => {
        if (!cancelled) setTwilioNumber(res.twilioNumber ?? null);
      })
      .catch(() => {
        if (!cancelled) setTwilioNumber(null);
      });
    return () => {
      cancelled = true;
    };
  }, [garageId]);

  const formattedNumber = twilioNumber ? prettifyUKNumber(twilioNumber) : null;

  return (
    <aside className="sticky top-0 flex h-screen w-64 flex-col border-r border-brand-700 bg-brand-600">
      {/* Logo */}
      <div className="flex items-center justify-center px-4 py-7">
        <img
          src="https://storage.googleapis.com/msgsndr/2UadumwHCXxeU9yxBIRC/media/65cf28be6e4392e608cca8a9.png"
          alt="ReceptionMate"
          className="h-20 w-auto"
        />
      </div>

      {/* Main nav — scrolls internally if it overflows so the bottom card
          stays pinned to the viewport. */}
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 pb-3">
        {items.map((item) => {
          // Special case: "Agent Configurations" gets a hover-flyout tray
          // showing all /agent-setup sub-pages. Clicking the parent navigates
          // to the first sub-page so users always land somewhere meaningful.
          if (item.href === '/agent-configurations') {
            return (
              <AgentConfigSidebarItem
                key={item.href}
                icon={item.icon}
                name={item.tKey ? t(item.tKey) : item.name}
                activePath={activePath}
                hasMessagingAccess={hasMessagingAccess}
              />
            );
          }

          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                item.isActive
                  ? 'bg-white text-brand-700 shadow-sm'
                  : 'text-brand-50 hover:bg-white/10 hover:text-white',
              )}
            >
              <span
                className={cn(
                  'inline-flex h-5 w-5 shrink-0 items-center justify-center transition-colors',
                  item.isActive ? 'text-brand-600' : 'text-brand-100 group-hover:text-white',
                )}
              >
                {item.icon}
              </span>
              <span className="flex-1 truncate">{item.tKey ? t(item.tKey) : item.name}</span>
              {item.href === '/messages' && messagesNeedingAttention > 0 && (
                <span className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-rose-500 px-1.5 text-xs font-semibold text-white">
                  {messagesNeedingAttention > 99 ? '99+' : messagesNeedingAttention}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      {/* Help */}
      <div className="border-t border-white/10 px-3 py-3">
        <div className="space-y-0.5">
          {supportItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                item.isActive
                  ? 'bg-white text-brand-700'
                  : 'text-brand-50 hover:bg-white/10 hover:text-white',
              )}
            >
              <span
                className={cn(
                  'inline-flex h-5 w-5 shrink-0 items-center justify-center transition-colors',
                  item.isActive ? 'text-brand-600' : 'text-brand-100 group-hover:text-white',
                )}
              >
                {item.icon}
              </span>
              <span>{item.tKey ? t(item.tKey) : item.name}</span>
            </Link>
          ))}
        </div>
      </div>

      {/* Language toggle */}
      <div className="flex items-center justify-between border-t border-white/10 px-4 py-2.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-brand-100">{t('common.language')}</span>
        <LanguageToggle />
      </div>

      {/* Your agent's number card — always visible at the bottom of the
          sidebar across every page, even if a number isn't yet assigned. */}
      <div className="border-t border-white/10 px-3 py-3">
        <div className="rounded-xl bg-white/10 p-3 ring-1 ring-white/15 backdrop-blur-sm">
          <div className="flex items-center gap-3">
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/15 text-white">
              <PhoneFilledIcon />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-brand-100">
                {t('sidebar.yourNumber')}
              </p>
              <p className="mt-0.5 truncate text-sm font-semibold text-white">
                {formattedNumber ?? t('sidebar.notAssigned')}
              </p>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}

function prettifyUKNumber(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+44') && digits.length === 13) {
    const rest = digits.slice(3);
    return `0${rest.slice(0, 3)} ${rest.slice(3, 6)} ${rest.slice(6)}`;
  }
  return raw;
}

/**
 * "Agent Configuration" sidebar entry with a hover-flyout tray showing every
 * /agent-setup sub-page. Uses position: fixed + JS-captured coordinates so
 * the tray escapes the parent <nav>'s overflow-y-auto clip box. A small close
 * delay lets the cursor traverse from trigger to tray without flickering shut.
 */
function AgentConfigSidebarItem({
  icon,
  name,
  activePath,
  hasMessagingAccess = false,
}: {
  icon: React.ReactNode;
  name: string;
  activePath: string;
  hasMessagingAccess?: boolean;
}) {
  const lang = useLang();
  const triggerRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const inAgentSetup = activePath.startsWith('/agent-setup');
  const isActive = activePath.startsWith('/agent-configurations') || inAgentSetup;

  const isStaff = isReceptionMateStaff();
  const setupItems: AgentSetupNavItem[] = AGENT_SETUP_NAV.filter(
    (n) => (!n.staffOnly || isStaff) && (!n.messagingOnly || hasMessagingAccess || isStaff),
  );

  const cancelClose = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  const handleEnter = () => {
    cancelClose();
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setPos({ top: rect.top, left: rect.right });
    }
    setOpen(true);
  };

  const handleLeave = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), 120);
  };

  useEffect(() => () => cancelClose(), []);

  return (
    <div
      ref={triggerRef}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      onFocus={handleEnter}
      onBlur={handleLeave}
      className="relative"
    >
      <Link
        href="/agent-setup/company-information"
        className={cn(
          'group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
          isActive
            ? 'bg-white text-brand-700 shadow-sm'
            : 'text-brand-50 hover:bg-white/10 hover:text-white',
        )}
      >
        <span
          className={cn(
            'inline-flex h-5 w-5 shrink-0 items-center justify-center transition-colors',
            isActive ? 'text-brand-600' : 'text-brand-100 group-hover:text-white',
          )}
        >
          {icon}
        </span>
        <span className="flex-1 truncate">{name}</span>
        <span aria-hidden className="text-brand-200 group-hover:text-white">›</span>
      </Link>

      {/* Portal the flyout straight into document.body so it escapes the
          sidebar's stacking context (sticky positioning creates one and
          traps fixed-positioned children regardless of z-index). */}
      {open && pos && typeof window !== 'undefined' && createPortal(
        <div
          onMouseEnter={handleEnter}
          onMouseLeave={handleLeave}
          style={{ position: 'fixed', top: pos.top, left: pos.left, zIndex: 9999 }}
          className="w-72 rounded-2xl border border-slate-200 bg-white p-2 shadow-2xl shadow-slate-900/10"
        >
          <div className="mb-2 px-2 pt-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            Agent Setup
          </div>
          <div className="space-y-0.5">
            {setupItems.map((sub) => {
              const subActive = activePath === sub.href;
              const fr = lang === 'fr' ? AGENT_SETUP_NAV_FR[sub.href] : undefined;
              const subLabel = fr?.label ?? sub.label;
              const subDescription = fr?.description ?? sub.description;
              return (
                <Link
                  key={sub.href}
                  href={sub.href}
                  className={cn(
                    'block rounded-lg px-3 py-2 text-sm transition-colors',
                    subActive
                      ? 'bg-brand-50 text-brand-700'
                      : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
                  )}
                >
                  <div className="font-medium">{subLabel}</div>
                  <div
                    className={cn(
                      'mt-0.5 text-xs',
                      subActive ? 'text-brand-500' : 'text-slate-500',
                    )}
                  >
                    {subDescription}
                  </div>
                </Link>
              );
            })}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

// ---- icons ----

function DashboardIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </svg>
  );
}

function PhoneIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  );
}

function PhoneFilledIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 2L11 13" />
      <path d="M22 2L15 22l-4-9-9-4 20-7z" />
    </svg>
  );
}

function TemplateIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="3" y1="9" x2="21" y2="9" />
      <line x1="9" y1="21" x2="9" y2="9" />
    </svg>
  );
}

function CogIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function UsersIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function PuzzleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19.43 12.98c.04-.32.07-.64.07-.98s-.03-.66-.07-.98l2.11-1.65a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.61-.22l-2.49 1a7.03 7.03 0 0 0-1.69-.98l-.38-2.65A.488.488 0 0 0 14 2h-4a.488.488 0 0 0-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1a.5.5 0 0 0-.61.22l-2 3.46a.5.5 0 0 0 .12.64L4.57 11c-.04.32-.07.65-.07.98s.03.66.07.98l-2.11 1.65a.5.5 0 0 0-.12.64l2 3.46a.5.5 0 0 0 .61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.05.24.25.42.49.42h4c.24 0 .44-.18.49-.42l.38-2.65c.61-.25 1.17-.59 1.69-.98l2.49 1c.22.09.49 0 .61-.22l2-3.46a.5.5 0 0 0-.12-.64l-2.11-1.65z" />
    </svg>
  );
}

function ChartIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="20" x2="12" y2="10" />
      <line x1="18" y1="20" x2="18" y2="4" />
      <line x1="6" y1="20" x2="6" y2="16" />
    </svg>
  );
}

function BillingIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <line x1="2" y1="10" x2="22" y2="10" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

function HelpIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}
