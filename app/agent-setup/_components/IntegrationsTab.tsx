'use client';

import { useEffect, useState } from 'react';
import type { AgentConfiguration } from '../../types';
import { useLang } from '@/app/i18n/LocaleProvider';
import TabShell from './TabShell';

interface Props {
  config: AgentConfiguration;
  save: (patch: Partial<AgentConfiguration>) => Promise<unknown>;
  isSaving: boolean;
}

export default function IntegrationsTab({ config, save, isSaving }: Props) {
  const lang = useLang();
  const c = {
    en: {
      title: 'Integrations',
      description:
        'Connect your CRM and other tools. Booking diary providers (GarageHive, Tyresoft) are configured by ReceptionMate staff during onboarding.',
      crmName: 'HubSpot CRM',
      crmBlurb: 'Push call summaries and contacts into your HubSpot account after every call.',
      tokenLabel: 'HubSpot API token',
      tokenHint: 'Private app access token with contacts + crm.objects.contacts.write scopes.',
      ownerLabel: 'Default owner ID',
      ownerHint: 'Numeric HubSpot owner ID — new contacts get assigned to this user.',
      inboxLabel: 'Inbox email',
      inboxHint:
        'HubSpot Conversations inbox address — call summaries are forwarded here for threading.',
    },
    fr: {
      title: 'Intégrations',
      description:
        "Connectez votre CRM et vos autres outils. Les fournisseurs d'agenda de réservation (GarageHive, Tyresoft) sont configurés par l'équipe ReceptionMate lors de la mise en service.",
      crmName: 'HubSpot CRM',
      crmBlurb:
        'Envoyez les récapitulatifs d’appel et les contacts vers votre compte HubSpot après chaque appel.',
      tokenLabel: 'Jeton API HubSpot',
      tokenHint:
        'Jeton d’accès d’application privée avec les portées contacts + crm.objects.contacts.write.',
      ownerLabel: 'ID de propriétaire par défaut',
      ownerHint:
        'ID numérique de propriétaire HubSpot — les nouveaux contacts sont attribués à cet utilisateur.',
      inboxLabel: 'Email de la boîte de réception',
      inboxHint:
        'Adresse de la boîte de réception HubSpot Conversations — les récapitulatifs d’appel y sont transférés pour le regroupement.',
    },
  }[lang];
  const [enabled, setEnabled] = useState(config.hubspotSettings?.enabled ?? false);
  const [apiToken, setApiToken] = useState(config.hubspotSettings?.apiToken ?? '');
  const [ownerId, setOwnerId] = useState(config.hubspotSettings?.ownerId ?? '');
  const [inboxEmail, setInboxEmail] = useState(config.hubspotSettings?.inboxEmail ?? '');

  useEffect(() => {
    setEnabled(config.hubspotSettings?.enabled ?? false);
    setApiToken(config.hubspotSettings?.apiToken ?? '');
    setOwnerId(config.hubspotSettings?.ownerId ?? '');
    setInboxEmail(config.hubspotSettings?.inboxEmail ?? '');
  }, [config]);

  const handleSave = () => {
    void save({
      hubspotSettings: { enabled, apiToken, ownerId, inboxEmail },
    });
  };

  return (
    <TabShell
      title={c.title}
      description={c.description}
      onSave={handleSave}
      isSaving={isSaving}
    >
      <div className="rounded-2xl border border-slate-300/60 bg-slate-50 p-4">
        <div className="mb-3 flex items-start justify-between gap-4">
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-slate-900">{c.crmName}</h3>
            <p className="mt-0.5 text-xs text-slate-500">
              {c.crmBlurb}
            </p>
          </div>
          <label className="relative inline-flex shrink-0 cursor-pointer items-center">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="peer sr-only"
            />
            <div className="h-6 w-11 rounded-full bg-slate-700 after:absolute after:start-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:bg-slate-300 after:transition-all peer-checked:bg-brand-600 peer-checked:after:translate-x-full peer-checked:after:bg-white" />
          </label>
        </div>

        {enabled && (
          <div className="space-y-3 border-t border-slate-200 pt-3">
            <Field label={c.tokenLabel} hint={c.tokenHint}>
              <input
                type="password"
                value={apiToken}
                onChange={(e) => setApiToken(e.target.value)}
                placeholder="pat-eu1-…"
                className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
              />
            </Field>
            <Field label={c.ownerLabel} hint={c.ownerHint}>
              <input
                type="text"
                value={ownerId}
                onChange={(e) => setOwnerId(e.target.value)}
                placeholder="12345678"
                className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
              />
            </Field>
            <Field label={c.inboxLabel} hint={c.inboxHint}>
              <input
                type="email"
                value={inboxEmail}
                onChange={(e) => setInboxEmail(e.target.value)}
                placeholder="inbox@yourgarage-conversations.hubspot.com"
                className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
              />
            </Field>
          </div>
        )}
      </div>

    </TabShell>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs text-slate-500">{label}</label>
      {children}
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}
