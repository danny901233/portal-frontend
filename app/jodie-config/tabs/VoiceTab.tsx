'use client';

import { useEffect, useState } from 'react';
import type { AgentConfiguration } from '../../types';
import TabShell from './TabShell';

interface Props {
  config: AgentConfiguration;
  save: (patch: Partial<AgentConfiguration>) => Promise<unknown>;
  isSaving: boolean;
}

type VoiceOption =
  | 'tom'
  | 'leah'
  | 'sophie'
  | 'gemma'
  | 'isobel'
  | 'fraser'
  | 'amelia';

interface VoiceCardDef {
  value: VoiceOption;
  label: string;
  description: string;
}

const VOICE_OPTIONS: VoiceCardDef[] = [
  { value: 'tom', label: 'Tom', description: 'Friendly mid-thirties male voice' },
  { value: 'leah', label: 'Leah', description: 'Pleasantly clear British female voice' },
  { value: 'sophie', label: 'Sophie', description: 'Clear and conversational female voice' },
  { value: 'gemma', label: 'Gemma', description: 'Modern Northern English friendly female voice' },
  { value: 'isobel', label: 'Isobel', description: 'Scottish female voice, youthful and warm' },
  { value: 'fraser', label: 'Fraser', description: 'Soft male Scottish Glaswegian voice' },
  { value: 'amelia', label: 'Amelia', description: 'Standard British female voice' },
];

export default function VoiceTab({ config, save, isSaving }: Props) {
  const [voice, setVoice] = useState<VoiceOption>(
    (config.voice as VoiceOption) ?? 'leah'
  );

  useEffect(() => {
    setVoice((config.voice as VoiceOption) ?? 'leah');
  }, [config.voice]);

  const handleSave = () => {
    void save({ voice });
  };

  return (
    <TabShell
      title="Voice & sound"
      description="Pick the voice the agent uses on every call. Changes apply to the next call."
      onSave={handleSave}
      isSaving={isSaving}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {VOICE_OPTIONS.map((opt) => {
          const isActive = voice === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => setVoice(opt.value)}
              className={`rounded-xl border p-4 text-left transition ${
                isActive
                  ? 'border-sky-500 bg-sky-500/10 shadow-lg shadow-sky-500/10'
                  : 'border-slate-700 bg-slate-950/40 hover:border-slate-500'
              }`}
            >
              <div className="flex items-center justify-between">
                <h3 className="text-base font-semibold text-slate-100">
                  {opt.label}
                </h3>
                {isActive && (
                  <span className="rounded-full bg-sky-500 px-2 py-0.5 text-xs font-medium text-white">
                    Selected
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs text-slate-400">{opt.description}</p>
            </button>
          );
        })}
      </div>

      <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-4 text-sm">
        <p className="text-slate-300">
          <strong className="text-slate-100">Current voice:</strong>{' '}
          {VOICE_OPTIONS.find((o) => o.value === voice)?.label ?? voice}
        </p>
        <p className="mt-1 text-xs text-slate-500">
          Advanced voice tuning (stability, similarity boost, style) is set
          globally for now — same for all garages. Contact RM staff if you need
          per-garage fine-tuning.
        </p>
      </div>
    </TabShell>
  );
}
