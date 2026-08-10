'use client';

import { useEffect, useState } from 'react';
import type { AgentConfiguration, CustomRule } from '../../types';
import { useLang } from '@/app/i18n/LocaleProvider';
import TabShell from './TabShell';

interface Props {
  config: AgentConfiguration;
  save: (patch: Partial<AgentConfiguration>) => Promise<unknown>;
  isSaving: boolean;
}

const MAX_RULES = 20;
const MAX_RULE_LENGTH = 500;

export default function BehaviorTab({ config, save, isSaving }: Props) {
  const lang = useLang();
  const c = {
    en: {
      title: 'Behavior & rules',
      description: 'How the agent talks and the rules it must always follow.',
      greetingLabel: 'Greeting line',
      greetingPlaceholder:
        "Good {timeofday}, you're through to the garridge — {name} speaking. How can I help?",
      greetingHintAfterName: " for the agent's name and ",
      greetingHintAfterTod:
        ' to be replaced with "good morning" / "good afternoon" / "good evening". Leave blank for the default greeting.',
      toneLabel: 'Tone',
      toneOptions: [
        { value: 'standard', label: 'Standard', description: 'Balanced, warm — feels like a real person' },
        { value: 'upbeat', label: 'Upbeat', description: 'Energetic and enthusiastic — smiles through the phone' },
        { value: 'professional', label: 'Professional', description: 'Polished, formal British receptionist register' },
      ],
      rulesLabel: 'Custom rules',
      rulesHintBefore:
        "Free-text rules the agent must follow on every call. Active rules are injected at the top of the agent's prompt and override defaults. Example: ",
      rulesExample: '"For air-con services tell callers to just turn up — no booking needed."',
      empty: 'No custom rules yet. Click "Add rule" to add one.',
      active: 'Active',
      rulePlaceholder: 'e.g. For air-con services tell callers to just turn up — no booking needed.',
      remove: 'Remove',
      add: '+ Add rule',
    },
    fr: {
      title: 'Comportement et règles',
      description: "La façon dont l'agent parle et les règles qu'il doit toujours respecter.",
      greetingLabel: "Ligne d'accueil",
      greetingPlaceholder:
        'Bonjour {timeofday}, vous êtes bien au garage — {name} à l’appareil. Comment puis-je vous aider ?',
      greetingHintAfterName: " pour le nom de l'agent et ",
      greetingHintAfterTod:
        ' pour être remplacé par « bonjour » / « bon après-midi » / « bonsoir ». Laissez vide pour le message d’accueil par défaut.',
      toneLabel: 'Ton',
      toneOptions: [
        { value: 'standard', label: 'Standard', description: 'Équilibré, chaleureux — donne l’impression d’une vraie personne' },
        { value: 'upbeat', label: 'Enjoué', description: 'Énergique et enthousiaste — le sourire s’entend au téléphone' },
        { value: 'professional', label: 'Professionnel', description: 'Registre de réceptionniste soigné et formel' },
      ],
      rulesLabel: 'Règles personnalisées',
      rulesHintBefore:
        "Règles en texte libre que l'agent doit suivre à chaque appel. Les règles actives sont insérées en haut du prompt de l'agent et priment sur les valeurs par défaut. Exemple : ",
      rulesExample:
        '« Pour les prestations de climatisation, dites aux appelants de simplement passer — sans réservation. »',
      empty: 'Aucune règle personnalisée pour l’instant. Cliquez sur « Ajouter une règle » pour en ajouter une.',
      active: 'Active',
      rulePlaceholder:
        'p. ex. Pour les prestations de climatisation, dites aux appelants de simplement passer — sans réservation.',
      remove: 'Supprimer',
      add: '+ Ajouter une règle',
    },
  }[lang];
  const TONE_OPTIONS = c.toneOptions as {
    value: 'standard' | 'upbeat' | 'professional';
    label: string;
    description: string;
  }[];
  const [greetingLine, setGreetingLine] = useState(config.greetingLine ?? '');
  const [tonePreference, setTonePreference] = useState<'standard' | 'upbeat' | 'professional'>(
    (config.tonePreference as 'standard' | 'upbeat' | 'professional') ?? 'standard'
  );
  const [rules, setRules] = useState<CustomRule[]>(config.customRules ?? []);

  useEffect(() => {
    setGreetingLine(config.greetingLine ?? '');
    setTonePreference(
      (config.tonePreference as 'standard' | 'upbeat' | 'professional') ?? 'standard'
    );
    setRules(config.customRules ?? []);
  }, [config]);

  const handleSave = () => {
    void save({ greetingLine, tonePreference, customRules: rules });
  };

  const addRule = () => {
    if (rules.length >= MAX_RULES) return;
    setRules([...rules, { text: '', active: true }]);
  };
  const removeRule = (idx: number) => setRules(rules.filter((_, i) => i !== idx));
  const updateRule = (idx: number, patch: Partial<CustomRule>) =>
    setRules(rules.map((r, i) => (i === idx ? { ...r, ...patch } : r)));

  return (
    <TabShell
      title={c.title}
      description={c.description}
      onSave={handleSave}
      isSaving={isSaving}
    >
      {/* Greeting line */}
      <div>
        <label className="mb-1 block text-sm font-medium text-slate-700">
          {c.greetingLabel}
        </label>
        <input
          type="text"
          value={greetingLine}
          onChange={(e) => setGreetingLine(e.target.value)}
          placeholder={c.greetingPlaceholder}
          className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
        />
        <p className="mt-1 text-xs text-slate-500">
          <code className="text-slate-500">{'{name}'}</code>{c.greetingHintAfterName}
          <code className="text-slate-500">timeofday</code>{c.greetingHintAfterTod}
        </p>
      </div>

      {/* Tone */}
      <div>
        <label className="mb-2 block text-sm font-medium text-slate-700">{c.toneLabel}</label>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {TONE_OPTIONS.map((opt) => {
            const isActive = tonePreference === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => setTonePreference(opt.value)}
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

      {/* Custom rules */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <label className="block text-sm font-medium text-slate-700">
            {c.rulesLabel}
            <span className="ml-2 text-xs text-slate-500">
              {rules.length} / {MAX_RULES}
            </span>
          </label>
        </div>
        <p className="mb-3 text-xs text-slate-500">
          {c.rulesHintBefore}
          <em>{c.rulesExample}</em>
        </p>

        <div className="space-y-2">
          {rules.length === 0 && (
            <div className="rounded-lg border border-dashed border-slate-300 px-4 py-6 text-center text-xs text-slate-500">
              {c.empty}
            </div>
          )}
          {rules.map((rule, idx) => (
            <div
              key={idx}
              className="rounded-lg border border-slate-200 bg-slate-50 p-3"
            >
              <div className="flex items-start gap-3">
                <label className="mt-1 flex shrink-0 cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={rule.active}
                    onChange={(e) => updateRule(idx, { active: e.target.checked })}
                    className="h-4 w-4 rounded border-slate-300 bg-slate-100 text-brand-600 focus:ring-brand-600"
                  />
                  <span className="text-xs font-medium text-slate-500">{c.active}</span>
                </label>
                <textarea
                  value={rule.text}
                  maxLength={MAX_RULE_LENGTH}
                  onChange={(e) => updateRule(idx, { text: e.target.value })}
                  placeholder={c.rulePlaceholder}
                  rows={2}
                  className="flex-1 rounded-md border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-900 placeholder-slate-500 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
                />
                <button
                  type="button"
                  onClick={() => removeRule(idx)}
                  className="shrink-0 rounded-md border border-slate-300 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-100 hover:text-rose-600"
                >
                  {c.remove}
                </button>
              </div>
            </div>
          ))}
        </div>

        <button
          type="button"
          onClick={addRule}
          disabled={rules.length >= MAX_RULES}
          className="mt-3 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {c.add}
        </button>
      </div>
    </TabShell>
  );
}
