'use client';

import type { ReactNode } from 'react';
import type { AgentConfiguration } from '../types';
import { useLang } from '@/app/i18n/LocaleProvider';
import { useAgentSetup } from './useAgentSetup';

interface Props {
  children: (props: {
    config: AgentConfiguration;
    save: (patch: Partial<AgentConfiguration>) => Promise<unknown>;
    isSaving: boolean;
    saveError: Error | null;
    saveSuccess: boolean;
    twilioNumber: string | null;
  }) => ReactNode;
}

/**
 * Wraps each /agent-setup/* page to handle loading / no-garage / error
 * states once, and pass a ready-to-use config + save callback to children.
 */
export default function PageGate({ children }: Props) {
  const { garageId, config, twilioNumber, isLoading, error, save, isSaving, saveError, saveSuccess } =
    useAgentSetup();
  const lang = useLang();
  const c = {
    en: {
      noGarage: 'No garage selected. Pick one from the branch selector in the main sidebar.',
      loading: 'Loading agent configuration…',
      loadFailed: (msg: string) => `Failed to load configuration: ${msg}`,
      noConfig: 'No configuration found for this garage.',
      saveFailed: (msg: string) => `Save failed: ${msg}`,
      saved: 'Saved ✓',
    },
    fr: {
      noGarage: "Aucune agence sélectionnée. Choisissez-en une dans le sélecteur d'agence de la barre latérale principale.",
      loading: "Chargement de la configuration de l'agent…",
      loadFailed: (msg: string) => `Échec du chargement de la configuration : ${msg}`,
      noConfig: 'Aucune configuration trouvée pour cette agence.',
      saveFailed: (msg: string) => `Échec de l'enregistrement : ${msg}`,
      saved: 'Enregistré ✓',
    },
  }[lang];

  if (!garageId) {
    return (
      <div className="rounded-2xl border border-amber-700/60 bg-amber-950/30 p-6 text-sm text-amber-800">
        {c.noGarage}
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-500">
        {c.loading}
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-2xl border border-rose-700/60 bg-rose-950/30 p-6 text-sm text-rose-800">
        {c.loadFailed((error as Error).message)}
      </div>
    );
  }

  if (!config) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-500">
        {c.noConfig}
      </div>
    );
  }

  return (
    // key={garageId} forces all child tabs to fully REMOUNT when the user
    // switches garage in the sidebar. This replaces the buggy useEffect that
    // each tab used to have to sync state with config.X on change — which
    // raced with user typing and wiped pending edits (transferNumber save bug
    // surfaced 2026-06-18).
    <div key={garageId}>
      {children({ config, save, isSaving, saveError: saveError as Error | null, saveSuccess, twilioNumber })}
      {saveError && (
        <div className="fixed bottom-4 right-4 rounded-lg bg-rose-600/90 px-4 py-3 text-sm text-white shadow-lg">
          {c.saveFailed(saveError.message)}
        </div>
      )}
      {saveSuccess && !isSaving && (
        <div className="fixed bottom-4 right-4 rounded-lg bg-emerald-600/90 px-4 py-3 text-sm text-white shadow-lg">
          {c.saved}
        </div>
      )}
    </div>
  );
}
