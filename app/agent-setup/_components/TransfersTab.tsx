'use client';

import { useState } from 'react';
import type { AgentConfiguration } from '../../types';
import { useLang } from '@/app/i18n/LocaleProvider';
import TabShell from './TabShell';

interface Props {
  config: AgentConfiguration;
  save: (patch: Partial<AgentConfiguration>) => Promise<unknown>;
  isSaving: boolean;
}

export default function TransfersTab({ config, save, isSaving }: Props) {
  // Lazy initializer — captures config values on first mount. PageGate keys
  // the parent on garageId, so this component fully remounts on garage switch
  // (no useEffect-driven state reset needed, which was racing with user typing
  // and wiping pending edits — bug surfaced 2026-06-18).
  const lang = useLang();
  const c = {
    en: {
      title: 'Call transfers',
      description:
        "Where to send calls the agent can't handle (complex complaints, warranty claims, etc.). Leave blank to keep all calls AI-handled.",
      label: 'Fallback transfer number',
      hint: 'Use full international format (e.g. +447123456789).',
      toggleLabel: 'Allow the agent to offer a transfer',
      toggleHint:
        'When ticked, the agent will offer to put callers through if it senses they need a real person. Untick to keep every call AI-handled regardless.',
    },
    fr: {
      title: 'Transferts d’appel',
      description:
        "Où envoyer les appels que l'agent ne peut pas traiter (réclamations complexes, demandes de garantie, etc.). Laissez vide pour que tous les appels restent gérés par l'IA.",
      label: 'Numéro de transfert de secours',
      hint: 'Utilisez le format international complet (p. ex. +447123456789).',
      toggleLabel: "Autoriser l'agent à proposer un transfert",
      toggleHint:
        "Lorsque cette case est cochée, l'agent proposera de mettre les appelants en relation s'il sent qu'ils ont besoin d'une vraie personne. Décochez pour que chaque appel reste géré par l'IA quoi qu'il arrive.",
    },
  }[lang];
  const [transferNumber, setTransferNumber] = useState(() => config.transferNumber ?? '');
  const [humanEscalation, setHumanEscalation] = useState(() => config.humanEscalation ?? true);

  const handleSave = () => {
    void save({
      transferNumber: transferNumber.trim(),
      humanEscalation,
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
        <label className="mb-1 block text-sm font-medium text-slate-700">{c.label}</label>
        <input
          type="tel"
          value={transferNumber}
          onChange={(e) => setTransferNumber(e.target.value)}
          placeholder="+44 1234 567890"
          className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
        />
        <p className="mt-1 text-xs text-slate-500">
          {c.hint}
        </p>
      </div>

      <label className="flex items-start gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
        <input
          type="checkbox"
          checked={humanEscalation}
          onChange={(e) => setHumanEscalation(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-600"
        />
        <div>
          <p className="text-sm font-medium text-slate-900">{c.toggleLabel}</p>
          <p className="mt-0.5 text-xs text-slate-500">
            {c.toggleHint}
          </p>
        </div>
      </label>
    </TabShell>
  );
}
