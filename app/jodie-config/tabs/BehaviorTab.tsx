'use client';

import { useEffect, useState } from 'react';
import type { AgentConfiguration, CustomRule } from '../../types';
import TabShell from './TabShell';

interface Props {
  config: AgentConfiguration;
  save: (patch: Partial<AgentConfiguration>) => Promise<unknown>;
  isSaving: boolean;
}

const TONE_OPTIONS: { value: 'standard' | 'upbeat' | 'professional'; label: string; description: string }[] = [
  { value: 'standard', label: 'Standard', description: 'Balanced, warm — feels like a real person' },
  { value: 'upbeat', label: 'Upbeat', description: 'Energetic and enthusiastic — smiles through the phone' },
  { value: 'professional', label: 'Professional', description: 'Polished, formal British receptionist register' },
];

const MAX_RULES = 20;
const MAX_RULE_LENGTH = 500;

export default function BehaviorTab({ config, save, isSaving }: Props) {
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
      title="Behavior & rules"
      description="How the agent talks and the rules it must always follow."
      onSave={handleSave}
      isSaving={isSaving}
    >
      {/* Greeting line */}
      <div>
        <label className="mb-1 block text-sm font-medium text-slate-700">
          Greeting line
        </label>
        <input
          type="text"
          value={greetingLine}
          onChange={(e) => setGreetingLine(e.target.value)}
          placeholder="Good {timeofday}, you're through to the garridge — {name} speaking. How can I help?"
          className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
        />
        <p className="mt-1 text-xs text-slate-500">
          Use <code className="text-slate-500">{'{name}'}</code> for the agent's name and{' '}
          <code className="text-slate-500">timeofday</code> to be replaced with "good morning"
          / "good afternoon" / "good evening". Leave blank for the default greeting.
        </p>
      </div>

      {/* Tone */}
      <div>
        <label className="mb-2 block text-sm font-medium text-slate-700">Tone</label>
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
                    ? 'border-brand-600 bg-brand-100'
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
            Custom rules
            <span className="ml-2 text-xs text-slate-500">
              {rules.length} / {MAX_RULES}
            </span>
          </label>
        </div>
        <p className="mb-3 text-xs text-slate-500">
          Free-text rules the agent must follow on every call. Active rules are injected
          at the top of the agent's prompt and override defaults. Example:{' '}
          <em>"For air-con services tell callers to just turn up — no booking needed."</em>
        </p>

        <div className="space-y-2">
          {rules.length === 0 && (
            <div className="rounded-lg border border-dashed border-slate-300 px-4 py-6 text-center text-xs text-slate-500">
              No custom rules yet. Click "Add rule" to add one.
            </div>
          )}
          {rules.map((rule, idx) => (
            <div
              key={idx}
              className="rounded-lg border border-slate-300/60 bg-slate-50 p-3"
            >
              <div className="flex items-start gap-3">
                <label className="mt-1 flex shrink-0 cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={rule.active}
                    onChange={(e) => updateRule(idx, { active: e.target.checked })}
                    className="h-4 w-4 rounded border-slate-300 bg-slate-100 text-emerald-500 focus:ring-emerald-500"
                  />
                  <span className="text-xs font-medium text-slate-500">Active</span>
                </label>
                <textarea
                  value={rule.text}
                  maxLength={MAX_RULE_LENGTH}
                  onChange={(e) => updateRule(idx, { text: e.target.value })}
                  placeholder="e.g. For air-con services tell callers to just turn up — no booking needed."
                  rows={2}
                  className="flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                />
                <button
                  type="button"
                  onClick={() => removeRule(idx)}
                  className="shrink-0 rounded-md border border-slate-300 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-100 hover:text-rose-300"
                >
                  Remove
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
          + Add rule
        </button>
      </div>
    </TabShell>
  );
}
