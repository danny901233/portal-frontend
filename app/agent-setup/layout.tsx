'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { cn } from '../lib/utils';
import { isReceptionMateStaff, getGarageId, getSessionToken } from '../lib/auth';
import { useLang } from '@/app/i18n/LocaleProvider';
import SetupProgress from './SetupProgress';
import TourBanner from './TourBanner';
import { AGENT_SETUP_NAV } from './_nav';

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

export default function AgentSetupLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const isStaff = isReceptionMateStaff();

  // Messaging tab is only relevant to garages on the chat product. Resolve
  // access the same way AppShell does (per-garage endpoint) and hide the tab
  // otherwise. Staff always see it so they can configure on a garage's behalf.
  const [hasMessagingAccess, setHasMessagingAccess] = useState(false);
  useEffect(() => {
    const garageId = getGarageId();
    if (!garageId) {
      setHasMessagingAccess(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/internal-api/garages/${garageId}/messaging-access`, {
          headers: { Authorization: `Bearer ${getSessionToken()}` },
        });
        if (!cancelled && res.ok) {
          const data = await res.json();
          setHasMessagingAccess(Boolean(data.hasMessagingAccess));
        }
      } catch {
        if (!cancelled) setHasMessagingAccess(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  const visible = AGENT_SETUP_NAV.filter(
    (n) => (!n.staffOnly || isStaff) && (!n.messagingOnly || hasMessagingAccess || isStaff),
  );
  const lang = useLang();
  const c = {
    en: {
      heading: 'Agent Setup',
      blurb: 'Configure this garage’s AI agent. Changes apply on next call.',
    },
    fr: {
      heading: "Configuration de l'agent",
      blurb: "Configurez l'agent IA de cette agence. Les changements s'appliquent au prochain appel.",
    },
  }[lang];

  return (
    <div className="flex min-h-screen bg-white text-slate-900">
      <aside className="w-64 shrink-0 border-r border-slate-200 bg-slate-50 px-3 py-6">
        <SetupProgress />
        <div className="px-3 pb-4">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            {c.heading}
          </h2>
          <p className="mt-1 text-xs text-slate-600">
            {c.blurb}
          </p>
        </div>
        <nav className="space-y-1">
          {visible.map((item) => {
            const isActive = pathname === item.href;
            const fr = lang === 'fr' ? AGENT_SETUP_NAV_FR[item.href] : undefined;
            const label = fr?.label ?? item.label;
            const description = fr?.description ?? item.description;
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
                <div className="font-medium">{label}</div>
                <div
                  className={cn(
                    'mt-0.5 text-xs',
                    isActive ? 'text-brand-700' : 'text-slate-500',
                  )}
                >
                  {description}
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
