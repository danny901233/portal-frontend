'use client';

import { useEffect, useState } from 'react';
import type { AgentConfiguration, Pronunciation } from '../../types';
import { useLang } from '@/app/i18n/LocaleProvider';
import TabShell from './TabShell';

interface Props {
  config: AgentConfiguration;
  save: (patch: Partial<AgentConfiguration>) => Promise<unknown>;
  isSaving: boolean;
}

const MAX_PRONUNCIATIONS = 30;

export default function PronunciationsTab({ config, save, isSaving }: Props) {
  const lang = useLang();
  const c = {
    en: {
      title: 'Pronunciations',
      description:
        "Tell the agent how to say tricky names, place names, or product terms. Spell it like you'd sound it out.",
      heading: 'Pronunciations',
      empty: 'No pronunciations yet. Click “Add pronunciation” to add one.',
      written: 'Written',
      writtenPlaceholder: 'e.g. Cholmondeley',
      soundItOut: 'Sound it out',
      soundItOutPlaceholder: 'Chumley',
      remove: 'Remove',
      add: '+ Add pronunciation',
    },
    fr: {
      title: 'Prononciations',
      description:
        "Indiquez à l'agent comment prononcer les noms difficiles, les noms de lieux ou les termes de produits. Écrivez-le comme il se prononce.",
      heading: 'Prononciations',
      empty: 'Aucune prononciation pour l’instant. Cliquez sur « Ajouter une prononciation » pour en ajouter une.',
      written: 'Écrit',
      writtenPlaceholder: 'p. ex. Cholmondeley',
      soundItOut: 'Prononciation',
      soundItOutPlaceholder: 'Chumley',
      remove: 'Supprimer',
      add: '+ Ajouter une prononciation',
    },
  }[lang];
  const [items, setItems] = useState<Pronunciation[]>(config.pronunciations ?? []);

  useEffect(() => {
    setItems(config.pronunciations ?? []);
  }, [config.pronunciations]);

  const addItem = () => {
    if (items.length >= MAX_PRONUNCIATIONS) return;
    setItems((prev) => [...prev, { written: '', spoken: '' }]);
  };
  const removeItem = (idx: number) => setItems((prev) => prev.filter((_, i) => i !== idx));
  const updateItem = (idx: number, patch: Partial<Pronunciation>) =>
    setItems((prev) => prev.map((p, i) => (i === idx ? { ...p, ...patch } : p)));

  const handleSave = () => {
    void save({
      pronunciations: items.filter((p) => p.written.trim() && p.spoken.trim()),
    });
  };

  return (
    <TabShell
      title={c.title}
      description={c.description}
      onSave={handleSave}
      isSaving={isSaving}
    >
      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-medium text-slate-700">{c.heading}</span>
          <span className="text-xs text-slate-500">
            {items.length} / {MAX_PRONUNCIATIONS}
          </span>
        </div>

        {items.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-center text-xs text-slate-500">
            {c.empty}
          </div>
        ) : (
          <ul className="space-y-2">
            {items.map((item, idx) => (
              <li key={idx} className="grid grid-cols-12 gap-2 rounded-lg border border-slate-200 bg-white p-3">
                <div className="col-span-5">
                  <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-slate-500">{c.written}</label>
                  <input
                    type="text"
                    value={item.written}
                    onChange={(e) => updateItem(idx, { written: e.target.value })}
                    placeholder={c.writtenPlaceholder}
                    className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
                  />
                </div>
                <div className="col-span-6">
                  <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-slate-500">{c.soundItOut}</label>
                  <input
                    type="text"
                    value={item.spoken}
                    onChange={(e) => updateItem(idx, { spoken: e.target.value })}
                    placeholder={c.soundItOutPlaceholder}
                    className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
                  />
                </div>
                <div className="col-span-1 flex items-end justify-end">
                  <button
                    type="button"
                    onClick={() => removeItem(idx)}
                    aria-label={c.remove}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 text-slate-500 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <button
          type="button"
          onClick={addItem}
          disabled={items.length >= MAX_PRONUNCIATIONS}
          className="mt-3 inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {c.add}
        </button>
      </div>
    </TabShell>
  );
}
