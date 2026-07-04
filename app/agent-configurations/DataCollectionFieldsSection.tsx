'use client';

import type { DataCollectionField } from '../types';
import { useLang } from '@/app/i18n/LocaleProvider';

// Default starter set surfaced when a garage hasn't configured any fields yet.
// Toggling these on/off and saving persists the full list (so unchecked fields
// also flow to the agent as inactive entries, not omissions).
const DEFAULT_FIELDS: DataCollectionField[] = [
  { key: 'caller_name', label: "Caller's full name", active: true, required: true, instruction: '' },
  { key: 'callback_phone', label: 'Best callback phone number', active: true, required: true, instruction: 'read back digit-by-digit before confirming' },
  { key: 'reason', label: 'Reason for the call', active: true, required: true, instruction: 'what work they need or what they want to know' },
  { key: 'vehicle_registration', label: 'Vehicle registration', active: true, required: false, instruction: 'ask only if the call is about a specific vehicle' },
  { key: 'mileage', label: 'Rough vehicle mileage', active: false, required: false, instruction: 'approximate is fine' },
  { key: 'email', label: 'Email address', active: false, required: false, instruction: 'for booking confirmation' },
  { key: 'postcode', label: 'Postcode and house number', active: false, required: false, instruction: 'for collection / drop-off address' },
  { key: 'preferred_callback_time', label: 'Preferred callback time', active: false, required: false, instruction: '' },
];

interface Props {
  fields: DataCollectionField[] | null | undefined;
  onChange: (fields: DataCollectionField[]) => void;
  disabled?: boolean;
}

export default function DataCollectionFieldsSection({ fields, onChange, disabled }: Props) {
  const lang = useLang();
  const c = {
    en: {
      title: 'Data Collection Fields',
      badge: 'RM Internal · Beta',
      desc:
        'Toggle which fields the agent must ask callers for. Used by the new RMB-Garage and ' +
        'RMB-Assist agents. Inactive fields are dropped from the agent prompt; required fields ' +
        'are flagged for the agent as must-collect.',
      resetDefaults: 'Reset defaults',
      active: 'Active',
      required: 'Required',
      remove: 'Remove',
      labelHeading: 'Label (caller-facing description)',
      labelPlaceholder: "e.g. Caller's full name",
      instructionHeading: 'Agent instruction (optional)',
      instructionPlaceholder: 'e.g. read back digit-by-digit',
      addField: '+ Add field',
      savedNote: (
        <>
          Saved to <code className="text-slate-400">configuration.dataCollectionFields</code>; the
          agent reads it on every call (5-min cache per garage).
        </>
      ),
    },
    fr: {
      title: 'Champs de collecte de données',
      badge: 'RM Interne · Bêta',
      desc:
        "Choisissez les champs que l'agent doit demander aux appelants. Utilisés par les nouveaux agents " +
        'RMB-Garage et RMB-Assist. Les champs inactifs sont retirés du prompt de l’agent ; les champs obligatoires ' +
        'sont signalés à l’agent comme devant impérativement être collectés.',
      resetDefaults: 'Réinitialiser',
      active: 'Actif',
      required: 'Obligatoire',
      remove: 'Supprimer',
      labelHeading: "Libellé (description destinée à l'appelant)",
      labelPlaceholder: "ex. Nom complet de l'appelant",
      instructionHeading: 'Instruction pour l’agent (facultatif)',
      instructionPlaceholder: 'ex. relire chiffre par chiffre',
      addField: '+ Ajouter un champ',
      savedNote: (
        <>
          Enregistré dans <code className="text-slate-400">configuration.dataCollectionFields</code> ; l&rsquo;agent
          le lit à chaque appel (cache de 5 min par garage).
        </>
      ),
    },
  }[lang];
  const effectiveFields: DataCollectionField[] =
    fields && fields.length > 0 ? fields : DEFAULT_FIELDS;

  const updateField = (idx: number, patch: Partial<DataCollectionField>) => {
    const next = effectiveFields.map((f, i) => (i === idx ? { ...f, ...patch } : f));
    onChange(next);
  };

  const removeField = (idx: number) => {
    const next = effectiveFields.filter((_, i) => i !== idx);
    onChange(next);
  };

  const addField = () => {
    const next: DataCollectionField[] = [
      ...effectiveFields,
      {
        key: `custom_${Date.now()}`,
        label: '',
        active: true,
        required: false,
        instruction: '',
      },
    ];
    onChange(next);
  };

  const resetToDefaults = () => {
    onChange(DEFAULT_FIELDS);
  };

  return (
    <section className="rounded-2xl border border-amber-700/60 bg-slate-900/60 p-6 shadow-lg shadow-slate-950/30">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-slate-100">{c.title}</h2>
            <span className="rounded bg-amber-600/20 px-2 py-0.5 text-xs font-medium text-amber-300">
              {c.badge}
            </span>
          </div>
          <p className="mt-1 text-sm text-slate-400">
            {c.desc}
          </p>
        </div>
        <button
          type="button"
          onClick={resetToDefaults}
          disabled={disabled}
          className="shrink-0 rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-800 disabled:opacity-50"
        >
          {c.resetDefaults}
        </button>
      </div>

      <div className="mt-5 space-y-3">
        {effectiveFields.map((field, idx) => (
          <div
            key={`${field.key}-${idx}`}
            className="rounded-xl border border-slate-800 bg-slate-950/50 p-4"
          >
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-slate-200">
                <input
                  type="checkbox"
                  checked={field.active}
                  onChange={(e) => updateField(idx, { active: e.target.checked })}
                  disabled={disabled}
                  className="h-4 w-4 rounded border-slate-600 bg-slate-800"
                />
                <span className="font-medium">{c.active}</span>
              </label>

              <label className="flex items-center gap-2 text-sm text-slate-200">
                <input
                  type="checkbox"
                  checked={field.required}
                  onChange={(e) => updateField(idx, { required: e.target.checked })}
                  disabled={disabled || !field.active}
                  className="h-4 w-4 rounded border-slate-600 bg-slate-800"
                />
                <span>{c.required}</span>
              </label>

              <div className="ml-auto flex items-center gap-2">
                <span className="rounded bg-slate-800 px-2 py-0.5 font-mono text-xs text-slate-400">
                  {field.key}
                </span>
                <button
                  type="button"
                  onClick={() => removeField(idx)}
                  disabled={disabled}
                  className="rounded-lg border border-red-900/50 px-2 py-1 text-xs text-red-400 hover:bg-red-950/40 disabled:opacity-50"
                >
                  {c.remove}
                </button>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
              <div>
                <label className="block text-xs font-medium uppercase tracking-wide text-slate-400">
                  {c.labelHeading}
                </label>
                <input
                  type="text"
                  value={field.label}
                  onChange={(e) => updateField(idx, { label: e.target.value })}
                  disabled={disabled}
                  maxLength={120}
                  placeholder={c.labelPlaceholder}
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-amber-600 focus:outline-none disabled:opacity-50"
                />
              </div>
              <div>
                <label className="block text-xs font-medium uppercase tracking-wide text-slate-400">
                  {c.instructionHeading}
                </label>
                <input
                  type="text"
                  value={field.instruction ?? ''}
                  onChange={(e) => updateField(idx, { instruction: e.target.value })}
                  disabled={disabled}
                  maxLength={280}
                  placeholder={c.instructionPlaceholder}
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-amber-600 focus:outline-none disabled:opacity-50"
                />
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4 flex items-center justify-between">
        <button
          type="button"
          onClick={addField}
          disabled={disabled}
          className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50"
        >
          {c.addField}
        </button>
        <p className="text-xs text-slate-500">
          {c.savedNote}
        </p>
      </div>
    </section>
  );
}
