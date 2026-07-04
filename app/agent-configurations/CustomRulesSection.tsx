'use client';

import type { CustomRule } from '../types';
import { useLang } from '@/app/i18n/LocaleProvider';

const MAX_RULES = 20;
const MAX_RULE_LENGTH = 500;

interface Props {
  rules: CustomRule[] | null | undefined;
  onChange: (rules: CustomRule[]) => void;
  disabled?: boolean;
}

export default function CustomRulesSection({ rules, onChange, disabled }: Props) {
  const lang = useLang();
  const c = {
    en: {
      title: 'Custom Rules',
      badge: 'New',
      desc: (
        <>
          Free-text behaviour rules the agent must follow on every call. Example:
          &ldquo;For air-con services tell callers to just turn up &mdash; no booking
          needed.&rdquo; Active rules are injected at the very top of the prompt and
          override the agent&rsquo;s defaults. Inactive rules are kept on file but not
          applied.
        </>
      ),
      rulesCount: (n: number) => `${n} / ${MAX_RULES} rules`,
      empty: (
        <>No custom rules yet. Click &ldquo;Add rule&rdquo; below to create one.</>
      ),
      active: 'Active',
      placeholder: 'e.g. For air-con services tell callers to just turn up — no booking needed.',
      chars: (n: number) => `${n} / ${MAX_RULE_LENGTH} chars`,
      remove: 'Remove',
      addRule: '+ Add rule',
      savedToPrefix: 'Saved to ',
    },
    fr: {
      title: 'Règles personnalisées',
      badge: 'Nouveau',
      desc: (
        <>
          Règles de comportement en texte libre que l&rsquo;agent doit suivre à chaque appel. Exemple :
          &ldquo;Pour les services de climatisation, dites aux appelants de simplement se présenter &mdash; aucune
          réservation nécessaire.&rdquo; Les règles actives sont insérées tout en haut du prompt et
          remplacent les valeurs par défaut de l&rsquo;agent. Les règles inactives sont conservées mais non
          appliquées.
        </>
      ),
      rulesCount: (n: number) => `${n} / ${MAX_RULES} règles`,
      empty: (
        <>Aucune règle personnalisée pour le moment. Cliquez sur &ldquo;Ajouter une règle&rdquo; ci-dessous pour en créer une.</>
      ),
      active: 'Active',
      placeholder: 'ex. Pour les services de climatisation, dites aux appelants de simplement se présenter — aucune réservation nécessaire.',
      chars: (n: number) => `${n} / ${MAX_RULE_LENGTH} caractères`,
      remove: 'Supprimer',
      addRule: '+ Ajouter une règle',
      savedToPrefix: 'Enregistré dans ',
    },
  }[lang];
  const effectiveRules: CustomRule[] = Array.isArray(rules) ? rules : [];

  const updateRule = (idx: number, patch: Partial<CustomRule>) => {
    const next = effectiveRules.map((r, i) => (i === idx ? { ...r, ...patch } : r));
    onChange(next);
  };

  const removeRule = (idx: number) => {
    const next = effectiveRules.filter((_, i) => i !== idx);
    onChange(next);
  };

  const addRule = () => {
    if (effectiveRules.length >= MAX_RULES) return;
    const next: CustomRule[] = [
      ...effectiveRules,
      { text: '', active: true },
    ];
    onChange(next);
  };

  return (
    <section className="rounded-2xl border border-slate-700/60 bg-slate-900/60 p-6 shadow-lg shadow-slate-950/30">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-slate-100">{c.title}</h2>
            <span className="rounded bg-emerald-600/20 px-2 py-0.5 text-xs font-medium text-emerald-300">
              {c.badge}
            </span>
          </div>
          <p className="mt-1 text-sm text-slate-400">
            {c.desc}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-xs text-slate-500">
            {c.rulesCount(effectiveRules.length)}
          </div>
        </div>
      </div>

      <div className="mt-5 space-y-3">
        {effectiveRules.length === 0 && (
          <div className="rounded-lg border border-dashed border-slate-700 px-4 py-6 text-center text-sm text-slate-500">
            {c.empty}
          </div>
        )}
        {effectiveRules.map((rule, idx) => (
          <div
            key={idx}
            className="rounded-lg border border-slate-700/60 bg-slate-950/40 p-4"
          >
            <div className="flex items-start gap-3">
              <label className="mt-1 flex shrink-0 cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={rule.active}
                  disabled={disabled}
                  onChange={(e) => updateRule(idx, { active: e.target.checked })}
                  className="h-4 w-4 rounded border-slate-600 bg-slate-800 text-emerald-500 focus:ring-emerald-500"
                />
                <span className="text-xs font-medium text-slate-400">{c.active}</span>
              </label>
              <div className="flex-1">
                <textarea
                  value={rule.text}
                  disabled={disabled}
                  maxLength={MAX_RULE_LENGTH}
                  onChange={(e) => updateRule(idx, { text: e.target.value })}
                  placeholder={c.placeholder}
                  rows={2}
                  className="block w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:opacity-50"
                />
                <div className="mt-1 flex items-center justify-between text-xs text-slate-500">
                  <span>{c.chars(rule.text.length)}</span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => removeRule(idx)}
                disabled={disabled}
                className="shrink-0 rounded-md border border-slate-700 px-2.5 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-800 hover:text-rose-300 disabled:opacity-50"
              >
                {c.remove}
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4 flex items-center justify-between">
        <button
          type="button"
          onClick={addRule}
          disabled={disabled || effectiveRules.length >= MAX_RULES}
          className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm font-medium text-slate-200 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {c.addRule}
        </button>
        <span className="text-xs text-slate-500">
          {c.savedToPrefix}<code className="text-slate-400">configuration.customRules</code>
        </span>
      </div>
    </section>
  );
}
