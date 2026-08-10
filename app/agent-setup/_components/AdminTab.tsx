'use client';

import { useEffect, useMemo, useState } from 'react';
import type {
  AgentConfiguration,
  GarageHiveSettings,
  IntegrationProvider,
  TyresoftSettings,
} from '../../types';
import { useLang } from '@/app/i18n/LocaleProvider';
import TabShell from './TabShell';

interface Props {
  config: AgentConfiguration;
  save: (patch: Partial<AgentConfiguration>) => Promise<unknown>;
  isSaving: boolean;
}

type AgentType = 'assist' | 'automate';
type AgentScript = 'receptionmate-agent' | 'receptionmate-agent-v3' | 'tyresoft-agent' | 'Assist-agent' | 'GarageHive-agent' | 'MMH-agent';

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
  const lang = useLang();
  const c = {
    en: {
      title: 'Routing (staff only)',
      description:
        'Which LiveKit agent serves this garage + diary provider credentials. Changing routing updates the SIP dispatch rule immediately.',
      staffWarning:
        '⚠️ Staff-only tab. Changes here re-route live calls to a different agent. Verify with a test call after saving.',
      configWarning: 'Configuration warning: ',
      ghMissing: {
        instanceUrl: 'Instance URL',
        apiKey: 'API key',
        customerId: 'Customer ID',
        locationId: 'Location ID',
      },
      ghWarn: (fields: string, isPlural: boolean) =>
        `Garage Hive is selected as the diary provider but ${fields} ${isPlural ? 'are' : 'is'} missing. Bookings will fail until this is set.`,
      agentTypeLabel: 'Agent type',
      agentTypeOptions: [
        { value: 'assist', label: 'Assist (message-only)', description: 'Agent takes messages, never tries to book' },
        { value: 'automate', label: 'Automate (full booking)', description: 'Agent can book + check diary' },
      ],
      agentScriptLabel: 'Agent script (LiveKit dispatch target)',
      agentScriptOptions: [
        { value: 'receptionmate-agent-v3', label: 'New Agent', description: 'Enhanced agent with supervisor architecture (Account 1)' },
        { value: 'receptionmate-agent', label: 'Legacy Agent', description: 'Original agent architecture (Account 1)' },
        { value: 'tyresoft-agent', label: 'Tyresoft Agent', description: 'Tyresoft tyre-centre integration (Account 1)' },
        { value: 'Assist-agent', label: 'RMB-Assist (Account 2)', description: 'New assist-mode agent on LiveKit Account 2 — ElevenLabs voice + per-garage rules' },
      ],
      agentScriptHint:
        'Saving with a different agent script triggers the onboarding service to update the SIP dispatch rule. Assist-agent routes to LiveKit Account 2; the others stay on Account 1.',
      diaryLabel: 'Diary integration',
      notConnected: 'Not connected',
      garageHive: 'Garage Hive',
      notConnectedDesc: 'Agent takes messages; bookings sent via SMS or email.',
      garageHiveDesc: 'Agent books + checks availability via Garage Hive.',
      ghCredsTitle: 'Garage Hive credentials',
      customerId: 'Customer ID',
      instanceUrl: 'Instance URL',
      apiKey: 'API key',
      locationId: 'Location ID',
      locationIdHint: 'Numeric location identifier in Garage Hive',
      apiKeyPlaceholder: 'Bearer token from Garage Hive',
      tsCredsTitle: 'Tyresoft credentials',
      workspace: 'Workspace',
      username: 'Username',
      password: 'Password',
      tsApiKeyPlaceholder: 'Tyresoft 3rd-party API key',
      depotId: 'Depot ID',
      depotIdHint: 'Numeric depot identifier in Tyresoft',
      channelId: 'Channel ID',
      channelIdHint:
        "Tyresoft 'client channel id' for this garage — bookings are rejected with 'Invalid client channel id' if this is wrong or unset",
      tyreMarkup: 'Tyre markup',
      tyreMarkupHint:
        'Added to the raw Tyresoft supplier price before the agent quotes. Leave value blank for no markup.',
      flatPerTyre: 'Flat £ per tyre',
      percentage: 'Percentage %',
    },
    fr: {
      title: 'Routage (personnel uniquement)',
      description:
        'Quel agent LiveKit dessert cette agence + les identifiants du fournisseur d’agenda. Modifier le routage met à jour immédiatement la règle de dispatch SIP.',
      staffWarning:
        "⚠️ Onglet réservé au personnel. Les changements ici redirigent les appels en direct vers un autre agent. Vérifiez avec un appel test après l'enregistrement.",
      configWarning: 'Avertissement de configuration : ',
      ghMissing: {
        instanceUrl: "URL de l'instance",
        apiKey: 'Clé API',
        customerId: 'ID client',
        locationId: 'ID d’emplacement',
      },
      ghWarn: (fields: string, isPlural: boolean) =>
        `Garage Hive est sélectionné comme fournisseur d’agenda mais ${fields} ${isPlural ? 'sont manquants' : 'est manquant'}. Les réservations échoueront tant que ce n’est pas renseigné.`,
      agentTypeLabel: "Type d'agent",
      agentTypeOptions: [
        { value: 'assist', label: 'Assist (message uniquement)', description: 'L’agent prend des messages, ne tente jamais de réserver' },
        { value: 'automate', label: 'Automate (réservation complète)', description: 'L’agent peut réserver + consulter l’agenda' },
      ],
      agentScriptLabel: 'Script d’agent (cible de dispatch LiveKit)',
      agentScriptOptions: [
        { value: 'receptionmate-agent-v3', label: 'New Agent', description: 'Agent amélioré avec architecture superviseur (Account 1)' },
        { value: 'receptionmate-agent', label: 'Legacy Agent', description: 'Architecture d’agent d’origine (Account 1)' },
        { value: 'tyresoft-agent', label: 'Tyresoft Agent', description: 'Intégration centre pneus Tyresoft (Account 1)' },
        { value: 'Assist-agent', label: 'RMB-Assist (Account 2)', description: 'Nouvel agent en mode assist sur LiveKit Account 2 — voix ElevenLabs + règles par agence' },
      ],
      agentScriptHint:
        'Enregistrer avec un script d’agent différent déclenche la mise à jour de la règle de dispatch SIP par le service de mise en service. Assist-agent est routé vers LiveKit Account 2 ; les autres restent sur Account 1.',
      diaryLabel: 'Intégration d’agenda',
      notConnected: 'Non connecté',
      garageHive: 'Garage Hive',
      notConnectedDesc: 'L’agent prend des messages ; les réservations sont envoyées par SMS ou email.',
      garageHiveDesc: 'L’agent réserve + vérifie les disponibilités via Garage Hive.',
      ghCredsTitle: 'Identifiants Garage Hive',
      customerId: 'ID client',
      instanceUrl: "URL de l'instance",
      apiKey: 'Clé API',
      locationId: 'ID d’emplacement',
      locationIdHint: 'Identifiant numérique d’emplacement dans Garage Hive',
      apiKeyPlaceholder: 'Jeton Bearer de Garage Hive',
      tsCredsTitle: 'Identifiants Tyresoft',
      workspace: 'Espace de travail',
      username: 'Nom d’utilisateur',
      password: 'Mot de passe',
      tsApiKeyPlaceholder: 'Clé API tierce Tyresoft',
      depotId: 'ID de dépôt',
      depotIdHint: 'Identifiant numérique de dépôt dans Tyresoft',
      channelId: 'ID de canal',
      channelIdHint:
        "'client channel id' Tyresoft pour cette agence — les réservations sont rejetées avec 'Invalid client channel id' si celui-ci est incorrect ou non défini",
      tyreMarkup: 'Marge sur pneus',
      tyreMarkupHint:
        'Ajoutée au prix fournisseur brut de Tyresoft avant que l’agent ne donne le devis. Laissez la valeur vide pour aucune marge.',
      flatPerTyre: 'Forfait £ par pneu',
      percentage: 'Pourcentage %',
    },
  }[lang];
  const AGENT_TYPE_OPTIONS = c.agentTypeOptions as { value: AgentType; label: string; description: string }[];
  const AGENT_SCRIPT_OPTIONS = c.agentScriptOptions as { value: AgentScript; label: string; description: string }[];
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
    if (!gh.instanceUrl.trim()) missing.push(c.ghMissing.instanceUrl);
    if (!gh.apiKey.trim()) missing.push(c.ghMissing.apiKey);
    if (!gh.customerId.trim()) missing.push(c.ghMissing.customerId);
    if (!gh.locationId.trim()) missing.push(c.ghMissing.locationId);
    if (missing.length === 0) return null;
    return c.ghWarn(missing.join(', '), missing.length !== 1);
  }, [integrationProvider, gh, c]);

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
      title={c.title}
      description={c.description}
      onSave={handleSave}
      isSaving={isSaving}
    >
      <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800">
        {c.staffWarning}
      </div>

      {ghMisconfigWarning && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <span className="font-semibold">{c.configWarning}&nbsp;</span>
          {ghMisconfigWarning}
        </div>
      )}

      <div>
        <label className="mb-2 block text-sm font-medium text-slate-700">
          {c.agentTypeLabel}
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
          {c.agentScriptLabel}
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
                <div className="flex flex-wrap items-center justify-between gap-1">
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
          {c.agentScriptHint}
        </p>
      </div>

      <div>
        <label className="mb-2 block text-sm font-medium text-slate-700">
          {c.diaryLabel}
        </label>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {(['none', 'garage_hive'] as IntegrationProvider[]).map((opt) => {
            const isActive = integrationProvider === opt;
            const label = opt === 'none' ? c.notConnected : c.garageHive;
            const description =
              opt === 'none'
                ? c.notConnectedDesc
                : c.garageHiveDesc;
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
          <h3 className="text-sm font-semibold text-slate-900">{c.ghCredsTitle}</h3>
          <Field label={c.customerId}>
            <input
              type="text"
              value={gh.customerId}
              onChange={(e) => setGh({ ...gh, customerId: e.target.value })}
              placeholder="e.g. devbc24_mpu"
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
            />
          </Field>
          <Field label={c.instanceUrl}>
            <input
              type="url"
              value={gh.instanceUrl}
              onChange={(e) => setGh({ ...gh, instanceUrl: e.target.value })}
              placeholder="https://yourgarage.garagehive.co.uk"
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
            />
          </Field>
          <Field label={c.apiKey}>
            <input
              type="password"
              value={gh.apiKey}
              onChange={(e) => setGh({ ...gh, apiKey: e.target.value })}
              placeholder={c.apiKeyPlaceholder}
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
            />
          </Field>
          <Field label={c.locationId} hint={c.locationIdHint}>
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
          <h3 className="text-sm font-semibold text-slate-900">{c.tsCredsTitle}</h3>
          <Field label={c.workspace}>
            <input
              type="text"
              value={ts.tsWorkspace}
              onChange={(e) => setTs({ ...ts, tsWorkspace: e.target.value })}
              placeholder="test"
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
            />
          </Field>
          <Field label={c.username}>
            <input
              type="text"
              value={ts.tsUsername}
              onChange={(e) => setTs({ ...ts, tsUsername: e.target.value })}
              placeholder="tyresoft_3pty_api"
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
            />
          </Field>
          <Field label={c.password}>
            <input
              type="password"
              value={ts.tsPassword}
              onChange={(e) => setTs({ ...ts, tsPassword: e.target.value })}
              placeholder="••••••••"
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
            />
          </Field>
          <Field label={c.apiKey}>
            <input
              type="password"
              value={ts.tsApiKey}
              onChange={(e) => setTs({ ...ts, tsApiKey: e.target.value })}
              placeholder={c.tsApiKeyPlaceholder}
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
            />
          </Field>
          <Field label={c.depotId} hint={c.depotIdHint}>
            <input
              type="text"
              value={ts.tsDepotId}
              onChange={(e) => setTs({ ...ts, tsDepotId: e.target.value })}
              placeholder="1"
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
            />
          </Field>
          <Field
            label={c.channelId}
            hint={c.channelIdHint}
          >
            <input
              type="text"
              inputMode="numeric"
              value={ts.tsChannelId ?? ''}
              onChange={(e) => {
                const v = e.target.value.trim();
                setTs({ ...ts, tsChannelId: v === '' ? undefined : Number(v) });
              }}
              placeholder="e.g. 31"
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
            />
          </Field>
          <Field
            label={c.tyreMarkup}
            hint={c.tyreMarkupHint}
          >
            <div className="flex flex-wrap gap-2">
              <select
                value={ts.tyreMarkupType ?? 'flat'}
                onChange={(e) =>
                  setTs({ ...ts, tyreMarkupType: e.target.value as 'flat' | 'percent' })
                }
                className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600 md:w-auto"
              >
                <option value="flat">{c.flatPerTyre}</option>
                <option value="percent">{c.percentage}</option>
              </select>
              <input
                type="number"
                step="0.01"
                min="0"
                value={ts.tyreMarkupValue ?? ''}
                onChange={(e) => setTs({ ...ts, tyreMarkupValue: e.target.value })}
                placeholder={ts.tyreMarkupType === 'percent' ? 'e.g. 15' : 'e.g. 28'}
                className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600 md:w-32"
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
