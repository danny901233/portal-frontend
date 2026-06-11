'use client';

import { useEffect, useState } from 'react';
import type { AgentConfiguration, DataCollectionField } from '../../types';
import TabShell from './TabShell';

interface Props {
  config: AgentConfiguration;
  save: (patch: Partial<AgentConfiguration>) => Promise<unknown>;
  isSaving: boolean;
}

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

export default function CaptureTab({ config, save, isSaving }: Props) {
  const [fields, setFields] = useState<DataCollectionField[]>(
    config.dataCollectionFields && config.dataCollectionFields.length > 0
      ? config.dataCollectionFields
      : DEFAULT_FIELDS
  );

  useEffect(() => {
    if (config.dataCollectionFields && config.dataCollectionFields.length > 0) {
      setFields(config.dataCollectionFields);
    } else {
      setFields(DEFAULT_FIELDS);
    }
  }, [config.dataCollectionFields]);

  const updateField = (idx: number, patch: Partial<DataCollectionField>) => {
    setFields(fields.map((f, i) => (i === idx ? { ...f, ...patch } : f)));
  };
  const removeField = (idx: number) =>
    setFields(fields.filter((_, i) => i !== idx));
  const addField = () => {
    setFields([
      ...fields,
      {
        key: `custom_${Date.now()}`,
        label: '',
        active: true,
        required: false,
        instruction: '',
      },
    ]);
  };
  const resetToDefaults = () => setFields(DEFAULT_FIELDS);

  const handleSave = () => {
    void save({ dataCollectionFields: fields });
  };

  return (
    <TabShell
      title="Information capture"
      description="What the agent should collect from every caller. Active fields are required by the agent; inactive ones are skipped."
      onSave={handleSave}
      isSaving={isSaving}
    >
      <div className="space-y-2">
        {fields.map((field, idx) => (
          <div
            key={`${field.key}-${idx}`}
            className="rounded-lg border border-slate-700/60 bg-slate-950/40 p-3"
          >
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex shrink-0 cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={field.active}
                  onChange={(e) => updateField(idx, { active: e.target.checked })}
                  className="h-4 w-4 rounded border-slate-600 bg-slate-800 text-emerald-500 focus:ring-emerald-500"
                />
                <span className="text-xs font-medium text-slate-400">Active</span>
              </label>
              <label className="flex shrink-0 cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={field.required}
                  disabled={!field.active}
                  onChange={(e) => updateField(idx, { required: e.target.checked })}
                  className="h-4 w-4 rounded border-slate-600 bg-slate-800 text-emerald-500 focus:ring-emerald-500 disabled:opacity-30"
                />
                <span className="text-xs font-medium text-slate-400">Required</span>
              </label>
              <span className="rounded bg-slate-800 px-2 py-0.5 font-mono text-xs text-slate-400">
                {field.key}
              </span>
              <button
                type="button"
                onClick={() => removeField(idx)}
                className="ml-auto rounded-md border border-slate-700 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-800 hover:text-rose-300"
              >
                Remove
              </button>
            </div>
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs text-slate-500">Label</label>
                <input
                  type="text"
                  value={field.label}
                  onChange={(e) => updateField(idx, { label: e.target.value })}
                  placeholder="e.g. Caller's full name"
                  className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-500">
                  Instruction to the agent (optional)
                </label>
                <input
                  type="text"
                  value={field.instruction ?? ''}
                  onChange={(e) =>
                    updateField(idx, { instruction: e.target.value })
                  }
                  placeholder="e.g. read back digit-by-digit"
                  className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
                />
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={addField}
          className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm font-medium text-slate-200 hover:bg-slate-800"
        >
          + Add field
        </button>
        <button
          type="button"
          onClick={resetToDefaults}
          className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-800"
        >
          Reset to defaults
        </button>
      </div>
    </TabShell>
  );
}
