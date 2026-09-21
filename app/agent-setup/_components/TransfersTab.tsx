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
      screenLabel: 'Ring this number before the agent answers',
      screenHint:
        'Callers hear your phone ringing first. The agent only picks up if nobody does. Use this when the number customers dial comes straight to us, with no phone system of your own to forward from.',
      screenSecondsLabel: 'Ring for',
      screenSecondsHint:
        'Seconds before the call passes to the agent. Keep it under your voicemail — if voicemail answers, the caller gets your answerphone instead of the agent.',
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
      screenLabel: "Faire sonner ce numéro avant que l'agent réponde",
      screenSecondsLabel: 'Sonnerie pendant',
      screenHint:
        "Les appelants entendent d'abord votre téléphone sonner. L'agent ne décroche que si personne ne répond. Utile lorsque le numéro composé par vos clients arrive directement chez nous.",
      screenSecondsHint:
        "Secondes avant que l'appel passe à l'agent. Restez en dessous de votre messagerie vocale, sinon l'appelant tombe sur le répondeur.",
    },
  }[lang];
  const [transferNumber, setTransferNumber] = useState(() => config.transferNumber ?? '');
  const [humanEscalation, setHumanEscalation] = useState(() => config.humanEscalation ?? true);
  const [screenBeforeAgent, setScreenBeforeAgent] = useState(() => config.screenBeforeAgent ?? false);
  const [screenRingSeconds, setScreenRingSeconds] = useState(() => config.screenRingSeconds ?? 15);

  const handleSave = () => {
    void save({
      transferNumber: transferNumber.trim(),
      humanEscalation,
      screenBeforeAgent,
      screenRingSeconds,
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
          checked={screenBeforeAgent}
          disabled={!transferNumber.trim()}
          onChange={(e) => setScreenBeforeAgent(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-600 disabled:opacity-40"
        />
        <div>
          <span className="block text-sm font-medium text-slate-700">{c.screenLabel}</span>
          <p className="mt-0.5 text-xs text-slate-500">{c.screenHint}</p>
          {screenBeforeAgent && (
            <div className="mt-3 flex items-center gap-2">
              <span className="text-xs font-medium text-slate-700">{c.screenSecondsLabel}</span>
              <input
                type="number"
                min={5}
                max={30}
                value={screenRingSeconds}
                onChange={(e) => setScreenRingSeconds(Number(e.target.value))}
                className="w-20 rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
              />
              <span className="text-xs text-slate-500">seconds</span>
            </div>
          )}
          {screenBeforeAgent && (
            <p className="mt-2 text-xs text-slate-500">{c.screenSecondsHint}</p>
          )}
        </div>
      </label>

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
