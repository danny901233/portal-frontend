'use client';

import { useState } from 'react';
import { isReceptionMateStaff } from '@/app/lib/auth';
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
      screenTitle: 'Ring a number before the agent answers',
      screenHint:
        'Only for lines whose published number points straight at ReceptionMate. Garages normally publish their own number and forward to us when nobody picks up, so the ringing already happens on their phone system and this should stay off.',
      screenLabel: 'Ring a number first',
      screenNumberLabel: 'Number to ring',
      screenNumberHint: 'Rung before the agent takes the call. Nothing to do with the transfer number above.',
      screenSecondsLabel: 'Ring for',
      screenSecondsHint:
        'Seconds before the call passes to the agent. Keep it under the voicemail — if voicemail answers, the caller gets the answerphone instead of the agent.',
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
      screenTitle: "Faire sonner un numéro avant que l'agent réponde",
      screenHint:
        "Uniquement pour les lignes dont le numéro publié pointe directement vers ReceptionMate. Les garages publient normalement leur propre numéro et nous transfèrent les appels sans réponse : la sonnerie a alors lieu sur leur standard et cette option doit rester désactivée.",
      screenLabel: "Faire d'abord sonner un numéro",
      screenNumberLabel: 'Numéro à appeler',
      screenNumberHint: "Appelé avant que l'agent ne prenne l'appel. Sans rapport avec le numéro de transfert ci-dessus.",
      screenSecondsLabel: 'Sonnerie pendant',
      screenSecondsHint:
        "Secondes avant que l'appel passe à l'agent. Restez en dessous de la messagerie vocale, sinon l'appelant tombe sur le répondeur.",
    },
  }[lang];
  const [transferNumber, setTransferNumber] = useState(() => config.transferNumber ?? '');
  const [humanEscalation, setHumanEscalation] = useState(() => config.humanEscalation ?? true);
  const [screenBeforeAgent, setScreenBeforeAgent] = useState(() => config.screenBeforeAgent ?? false);
  const [screenNumber, setScreenNumber] = useState(() => config.screenNumber ?? '');
  // Staff-only: nearly every garage screens on its own phone system before forwarding to us,
  // so showing this to customers invites them to break a setup that already works.
  const [showScreening] = useState(() => isReceptionMateStaff());
  const [screenRingSeconds, setScreenRingSeconds] = useState(() => config.screenRingSeconds ?? 15);

  const handleSave = () => {
    void save({
      transferNumber: transferNumber.trim(),
      humanEscalation,
      screenBeforeAgent,
      screenNumber: screenNumber.trim(),
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

      {showScreening && (
        <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-3">
          <p className="text-sm font-medium text-slate-800">{c.screenTitle}</p>
          <p className="mt-0.5 text-xs text-slate-600">{c.screenHint}</p>

          <label className="mt-3 flex items-start gap-3">
            <input
              type="checkbox"
              checked={screenBeforeAgent}
              onChange={(e) => setScreenBeforeAgent(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-600"
            />
            <span className="text-sm text-slate-700">{c.screenLabel}</span>
          </label>

          {screenBeforeAgent && (
            <div className="mt-3 space-y-3 border-t border-amber-200 pt-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-700">{c.screenNumberLabel}</label>
                <input
                  type="tel"
                  value={screenNumber}
                  onChange={(e) => setScreenNumber(e.target.value)}
                  placeholder="+44 7123 456789"
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
                />
                <p className="mt-1 text-xs text-slate-500">{c.screenNumberHint}</p>
              </div>
              <div>
                <div className="flex items-center gap-2">
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
                <p className="mt-1 text-xs text-slate-500">{c.screenSecondsHint}</p>
              </div>
            </div>
          )}
        </div>
      )}

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
