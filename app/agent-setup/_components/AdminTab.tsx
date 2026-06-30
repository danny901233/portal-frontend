'use client';

import { useEffect, useMemo, useState } from 'react';
import type {
  AgentConfiguration,
  GarageHiveSettings,
  IntegrationProvider,
  TyresoftSettings,
} from '../../types';
import TabShell from './TabShell';

interface Props {
  config: AgentConfiguration;
  save: (patch: Partial<AgentConfiguration>) => Promise<unknown>;
  isSaving: boolean;
}

type AgentType = 'assist' | 'automate';
type AgentScript = 'receptionmate-agent' | 'receptionmate-agent-v3' | 'tyresoft-agent' | 'Assist-agent';

const AGENT_TYPE_OPTIONS: { value: AgentType; label: string; description: string }[] = [
  { value: 'assist', label: 'Assist (message-only)', description: 'Agent takes messages, never tries to book' },
  { value: 'automate', label: 'Automate (full booking)', description: 'Agent can book + check diary' },
];

const AGENT_SCRIPT_OPTIONS: { value: AgentScript; label: string; description: string }[] = [
  { value: 'receptionmate-agent-v3', label: 'New Agent', description: 'Enhanced agent with supervisor architecture (Account 1)' },
  { value: 'receptionmate-agent', label: 'Legacy Agent', description: 'Original agent architecture (Account 1)' },
  { value: 'tyresoft-agent', label: 'Tyresoft Agent', description: 'Tyresoft tyre-centre integration (Account 1)' },
  { value: 'Assist-agent', label: 'RMB-Assist (Account 2)', description: 'New assist-mode agent on LiveKit Account 2 — ElevenLabs voice + per-garage rules' },
];

const EMPTY_GH: GarageHiveSettings = {
  instanceUrl: '',
  apiKey: '',
  customerId: '',
  locationId: '',
};

const EMPTY_TS: TyresoftSettings = {
  tsWorkspace: '',
  tsUsername: '',
  tsPassword: '',
  tsApiKey: '',
  tsDepotId: '',
  tyreMarkupType: 'flat',
  tyreMarkupValue: '',
};

export default function AdminTab({ config, save, isSaving }: Props) {
  const [agentType, setAgentType] = useState<AgentType>(
    (config.agentType as AgentType) ?? 'assist'
  );
  const [agentScript, setAgentScript] = useState<AgentScript>(
    (config.agentScript as AgentScript) ?? 'receptionmate-agent-v3'
  );
  const [integrationProvider, setIntegrationProvider] = useState<IntegrationProvider>(
    (config.integrationProvider as IntegrationProvider) ?? 'none'
  );
  const [gh, setGh] = useState<GarageHiveSettings>({
    ...EMPTY_GH,
    ...(config.garageHiveSettings ?? {}),
  });
  const [ts, setTs] = useState<TyresoftSettings>({
    ...EMPTY_TS,
    ...(config.tyresoftSettings ?? {}),
  });

  useEffect(() => {
    setAgentType((config.agentType as AgentType) ?? 'assist');
    setAgentScript((config.agentScript as AgentScript) ?? 'receptionmate-agent-v3');
    setIntegrationProvider((config.integrationProvider as IntegrationProvider) ?? 'none');
    setGh({ ...EMPTY_GH, ...(config.garageHiveSettings ?? {}) });
    setTs({ ...EMPTY_TS, ...(config.tyresoftSettings ?? {}) });
  }, [config]);

  // GH misconfig warning: provider is garage_hive but any of the 4 required
  // GH fields is empty. Same logic the old /agent-configurations page uses.
  const ghMisconfigWarning = useMemo(() => {
    if (integrationProvider !== 'garage_hive') return null;
    const missing: string[] = [];
    if (!gh.instanceUrl.trim()) missing.push('Instance URL');
    if (!gh.apiKey.trim()) missing.push('API key');
    if (!gh.customerId.trim()) missing.push('Customer ID');
    if (!gh.locationId.trim()) missing.push('Location ID');
    if (missing.length === 0) return null;
    return `Garage Hive is selected as the diary provider but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing. Bookings will fail until this is set.`;
  }, [integrationProvider, gh]);

  const handleSave = () => {
    void save({
      agentType,
      agentScript,
      integrationProvider,
      garageHiveSettings: gh,
      tyresoftSettings: ts,
    });
  };

  return (
    <TabShell
      title="Routing (staff only)"
      description="Which LiveKit agent serves this garage + diary provider credentials. Changing routing updates the SIP dispatch rule immediately."
      onSave={handleSave}
      isSaving={isSaving}
    >
      <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800">
        ⚠️ Staff-only tab. Changes here re-route live calls to a different agent.
        Verify with a test call after saving.
      </div>

      {ghMisconfigWarning && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <span className="font-semibold">Configuration warning:&nbsp;</span>
          {ghMisconfigWarning}
        </div>
      )}

      <div>
        <label className="mb-2 block text-sm font-medium text-slate-700">
          Agent type
        </label>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {AGENT_TYPE_OPTIONS.map((opt) => {
            const isActive = agentType === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => setAgentType(opt.value)}
                className={`rounded-xl border p-3 text-left transition ${
                  isActive
                    ? 'border-brand-600 bg-brand-50'
                    : 'border-slate-300 bg-slate-50 hover:border-slate-500'
                }`}
              >
                <div className="text-sm font-semibold text-slate-900">{opt.label}</div>
                <div className="mt-0.5 text-xs text-slate-500">{opt.description}</div>
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <label className="mb-2 block text-sm font-medium text-slate-700">
          Agent script (LiveKit dispatch target)
        </label>
        <div className="grid grid-cols-1 gap-2">
          {AGENT_SCRIPT_OPTIONS.map((opt) => {
            const isActive = agentScript === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => setAgentScript(opt.value)}
                className={`rounded-xl border p-3 text-left transition ${
                  isActive
                    ? 'border-brand-600 bg-brand-50'
                    : 'border-slate-300 bg-slate-50 hover:border-slate-500'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold text-slate-900">{opt.label}</div>
                  <code className="rounded bg-slate-50 px-2 py-0.5 font-mono text-xs text-slate-500">
                    {opt.value}
                  </code>
                </div>
                <div className="mt-0.5 text-xs text-slate-500">{opt.description}</div>
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-xs text-slate-500">
          Saving with a different agent script triggers the onboarding service to update
          the SIP dispatch rule. Assist-agent routes to LiveKit Account 2; the others stay
          on Account 1.
        </p>
      </div>

      <div>
        <label className="mb-2 block text-sm font-medium text-slate-700">
          Diary integration
        </label>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {(['none', 'garage_hive'] as IntegrationProvider[]).map((opt) => {
            const isActive = integrationProvider === opt;
            const label = opt === 'none' ? 'Not connected' : 'Garage Hive';
            const description =
              opt === 'none'
                ? 'Agent takes messages; bookings sent via SMS or email.'
                : 'Agent books + checks availability via Garage Hive.';
            return (
              <button
                key={opt}
                type="button"
                onClick={() => setIntegrationProvider(opt)}
                className={`rounded-xl border p-3 text-left transition ${
                  isActive
                    ? 'border-brand-600 bg-brand-50'
                    : 'border-slate-300 bg-slate-50 hover:border-slate-500'
                }`}
              >
                <div className="text-sm font-semibold text-slate-900">{label}</div>
                <div className="mt-0.5 text-xs text-slate-500">{description}</div>
              </button>
            );
          })}
        </div>
      </div>

      {integrationProvider === 'garage_hive' && (
        <div className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <h3 className="text-sm font-semibold text-slate-900">Garage Hive credentials</h3>
          <Field label="Customer ID">
            <input
              type="text"
              value={gh.customerId}
              onChange={(e) => setGh({ ...gh, customerId: e.target.value })}
              placeholder="e.g. devbc24_mpu"
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
            />
          </Field>
          <Field label="Instance URL">
            <input
              type="url"
              value={gh.instanceUrl}
              onChange={(e) => setGh({ ...gh, instanceUrl: e.target.value })}
              placeholder="https://yourgarage.garagehive.co.uk"
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
            />
          </Field>
          <Field label="API key">
            <input
              type="password"
              value={gh.apiKey}
              onChange={(e) => setGh({ ...gh, apiKey: e.target.value })}
              placeholder="Bearer token from Garage Hive"
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
            />
          </Field>
          <Field label="Location ID" hint="Numeric location identifier in Garage Hive">
            <input
              type="text"
              value={gh.locationId}
              onChange={(e) => setGh({ ...gh, locationId: e.target.value })}
              placeholder="399"
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
            />
          </Field>
        </div>
      )}

      {agentScript === 'tyresoft-agent' && (
        <div className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <h3 className="text-sm font-semibold text-slate-900">Tyresoft credentials</h3>
          <Field label="Workspace">
            <input
              type="text"
              value={ts.tsWorkspace}
              onChange={(e) => setTs({ ...ts, tsWorkspace: e.target.value })}
              placeholder="test"
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
            />
          </Field>
          <Field label="Username">
            <input
              type="text"
              value={ts.tsUsername}
              onChange={(e) => setTs({ ...ts, tsUsername: e.target.value })}
              placeholder="tyresoft_3pty_api"
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
            />
          </Field>
          <Field label="Password">
            <input
              type="password"
              value={ts.tsPassword}
              onChange={(e) => setTs({ ...ts, tsPassword: e.target.value })}
              placeholder="••••••••"
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
            />
          </Field>
          <Field label="API key">
            <input
              type="password"
              value={ts.tsApiKey}
              onChange={(e) => setTs({ ...ts, tsApiKey: e.target.value })}
              placeholder="Tyresoft 3rd-party API key"
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
            />
          </Field>
          <Field label="Depot ID" hint="Numeric depot identifier in Tyresoft">
            <input
              type="text"
              value={ts.tsDepotId}
              onChange={(e) => setTs({ ...ts, tsDepotId: e.target.value })}
              placeholder="1"
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
            />
          </Field>
          <Field
            label="Tyre markup"
            hint="Added to the raw Tyresoft supplier price before the agent quotes. Leave value blank for no markup."
          >
            <div className="flex gap-2">
              <select
                value={ts.tyreMarkupType ?? 'flat'}
                onChange={(e) =>
                  setTs({ ...ts, tyreMarkupType: e.target.value as 'flat' | 'percent' })
                }
                className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
              >
                <option value="flat">Flat £ per tyre</option>
                <option value="percent">Percentage %</option>
              </select>
              <input
                type="number"
                step="0.01"
                min="0"
                value={ts.tyreMarkupValue ?? ''}
                onChange={(e) => setTs({ ...ts, tyreMarkupValue: e.target.value })}
                placeholder={ts.tyreMarkupType === 'percent' ? 'e.g. 15' : 'e.g. 28'}
                className="w-32 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
              />
            </div>
          </Field>
        </div>
      )}
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
