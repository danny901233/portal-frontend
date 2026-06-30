'use client';

import { useEffect, useState } from 'react';
import type { AgentConfiguration, CustomRule } from '../../types';
import TabShell from './TabShell';

interface Props {
  config: AgentConfiguration;
  save: (patch: Partial<AgentConfiguration>) => Promise<unknown>;
  isSaving: boolean;
}

const MAX_RULES = 20;

export default function RulesTab({ config, save, isSaving }: Props) {
  const [rules, setRules] = useState<CustomRule[]>(config.customRules ?? []);

  useEffect(() => {
    setRules(config.customRules ?? []);
  }, [config.customRules]);

  const addRule = () => {
    if (rules.length >= MAX_RULES) return;
    setRules((prev) => [...prev, { text: '', active: true }]);
  };
  const removeRule = (idx: number) => setRules((prev) => prev.filter((_, i) => i !== idx));
  const updateRule = (idx: number, patch: Partial<CustomRule>) =>
    setRules((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));

  const handleSave = () => {
    void save({ customRules: rules.filter((r) => r.text.trim().length > 0) });
  };

  return (
    <TabShell
      title="Custom rules"
      description="Short sentences the agent must obey on every call. Examples: 'Always offer a courtesy car for MOT bookings', 'For air-con regas — tell callers to just turn up, no booking needed'."
      onSave={handleSave}
      isSaving={isSaving}
    >
      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-medium text-slate-700">Rules</span>
          <span className="text-xs text-slate-500">
            {rules.length} / {MAX_RULES}
          </span>
        </div>

        {rules.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-center text-xs text-slate-500">
            No rules yet. Click &ldquo;Add rule&rdquo; to add one.
          </div>
        ) : (
          <ul className="space-y-2">
            {rules.map((rule, idx) => (
              <li key={idx} className="rounded-lg border border-slate-200 bg-white p-3">
                <textarea
                  value={rule.text}
                  onChange={(e) => updateRule(idx, { text: e.target.value })}
                  rows={2}
                  placeholder="e.g. Always offer a courtesy car for MOT bookings"
                  className="w-full resize-none rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
                />
                <div className="mt-2 flex items-center justify-between">
                  <label className="flex items-center gap-2 text-xs text-slate-600">
                    <input
                      type="checkbox"
                      checked={rule.active}
                      onChange={(e) => updateRule(idx, { active: e.target.checked })}
                      className="h-3.5 w-3.5 rounded border-slate-300 text-brand-600 focus:ring-brand-600"
                    />
                    Active
                  </label>
                  <button
                    type="button"
                    onClick={() => removeRule(idx)}
                    className="text-xs font-medium text-rose-600 hover:text-rose-700"
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <button
          type="button"
          onClick={addRule}
          disabled={rules.length >= MAX_RULES}
          className="mt-3 inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          + Add rule
        </button>
      </div>
    </TabShell>
  );
}
