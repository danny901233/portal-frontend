'use client';

import { useEffect, useState } from 'react';
import type { AgentConfiguration } from '../../types';
import TabShell from './TabShell';

interface Props {
  config: AgentConfiguration;
  save: (patch: Partial<AgentConfiguration>) => Promise<unknown>;
  isSaving: boolean;
}

type IntegrationProvider = 'none' | 'garage_hive';

export default function IntegrationsTab({ config, save, isSaving }: Props) {
  const [provider, setProvider] = useState<IntegrationProvider>(
    (config.integrationProvider as IntegrationProvider) ?? 'none'
  );
  const [ghCustomerId, setGhCustomerId] = useState(
    config.garageHiveSettings?.customerId ?? ''
  );
  const [ghInstanceUrl, setGhInstanceUrl] = useState(
    config.garageHiveSettings?.instanceUrl ?? ''
  );
  const [ghApiKey, setGhApiKey] = useState(
    config.garageHiveSettings?.apiKey ?? ''
  );
  const [ghLocationId, setGhLocationId] = useState(
    config.garageHiveSettings?.locationId ?? ''
  );
  const [notificationEmails, setNotificationEmails] = useState(
    (config.notificationEmails ?? []).join('\n')
  );

  useEffect(() => {
    setProvider((config.integrationProvider as IntegrationProvider) ?? 'none');
    setGhCustomerId(config.garageHiveSettings?.customerId ?? '');
    setGhInstanceUrl(config.garageHiveSettings?.instanceUrl ?? '');
    setGhApiKey(config.garageHiveSettings?.apiKey ?? '');
    setGhLocationId(config.garageHiveSettings?.locationId ?? '');
    setNotificationEmails((config.notificationEmails ?? []).join('\n'));
  }, [config]);

  const handleSave = () => {
    const emailList = notificationEmails
      .split('\n')
      .map((e) => e.trim())
      .filter(Boolean);
    void save({
      integrationProvider: provider,
      garageHiveSettings:
        provider === 'garage_hive'
          ? {
              customerId: ghCustomerId,
              instanceUrl: ghInstanceUrl,
              apiKey: ghApiKey,
              locationId: ghLocationId,
            }
          : config.garageHiveSettings,
      notificationEmails: emailList,
    });
  };

  return (
    <TabShell
      title="Integrations"
      description="Where bookings + notifications go."
      onSave={handleSave}
      isSaving={isSaving}
    >
      <div>
        <label className="mb-2 block text-sm font-medium text-slate-200">
          Diary integration
        </label>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {(['none', 'garage_hive'] as IntegrationProvider[]).map((opt) => {
            const isActive = provider === opt;
            const label = opt === 'none' ? 'Not connected' : 'GarageHive';
            const description =
              opt === 'none'
                ? 'Agent always takes a message — no booking attempts.'
                : 'Agent can book + check availability via GarageHive.';
            return (
              <button
                key={opt}
                type="button"
                onClick={() => setProvider(opt)}
                className={`rounded-xl border p-3 text-left transition ${
                  isActive
                    ? 'border-sky-500 bg-sky-500/10'
                    : 'border-slate-700 bg-slate-950/40 hover:border-slate-500'
                }`}
              >
                <div className="text-sm font-semibold text-slate-100">{label}</div>
                <div className="mt-0.5 text-xs text-slate-400">{description}</div>
              </button>
            );
          })}
        </div>
      </div>

      {provider === 'garage_hive' && (
        <div className="space-y-3 rounded-lg border border-slate-700/60 bg-slate-950/40 p-4">
          <h3 className="text-sm font-semibold text-slate-200">GarageHive credentials</h3>
          <Field label="Customer ID">
            <input
              type="text"
              value={ghCustomerId}
              onChange={(e) => setGhCustomerId(e.target.value)}
              placeholder="e.g. devbc24_mpu"
              className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
            />
          </Field>
          <Field label="Instance URL">
            <input
              type="url"
              value={ghInstanceUrl}
              onChange={(e) => setGhInstanceUrl(e.target.value)}
              placeholder="https://yourgarage.garagehive.co.uk"
              className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
            />
          </Field>
          <Field label="API key">
            <input
              type="password"
              value={ghApiKey}
              onChange={(e) => setGhApiKey(e.target.value)}
              placeholder="Bearer token from GarageHive"
              className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
            />
          </Field>
          <Field label="Location ID" hint="Numeric location identifier in GarageHive">
            <input
              type="text"
              value={ghLocationId}
              onChange={(e) => setGhLocationId(e.target.value)}
              placeholder="399"
              className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
            />
          </Field>
        </div>
      )}

      <div>
        <label className="mb-1 block text-sm font-medium text-slate-200">
          Notification emails
        </label>
        <textarea
          value={notificationEmails}
          onChange={(e) => setNotificationEmails(e.target.value)}
          rows={4}
          placeholder="manager@garage.co.uk&#10;reception@garage.co.uk"
          className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
        />
        <p className="mt-1 text-xs text-slate-500">
          One email per line. Each call summary gets sent to these addresses.
        </p>
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
