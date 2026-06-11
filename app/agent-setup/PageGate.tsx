'use client';

import type { ReactNode } from 'react';
import type { AgentConfiguration } from '../types';
import { useAgentSetup } from './useAgentSetup';

interface Props {
  children: (props: {
    config: AgentConfiguration;
    save: (patch: Partial<AgentConfiguration>) => Promise<unknown>;
    isSaving: boolean;
    saveError: Error | null;
    saveSuccess: boolean;
  }) => ReactNode;
}

/**
 * Wraps each /agent-setup/* page to handle loading / no-garage / error
 * states once, and pass a ready-to-use config + save callback to children.
 */
export default function PageGate({ children }: Props) {
  const { garageId, config, isLoading, error, save, isSaving, saveError, saveSuccess } =
    useAgentSetup();

  if (!garageId) {
    return (
      <div className="rounded-2xl border border-amber-700/60 bg-amber-950/30 p-6 text-sm text-amber-200">
        No garage selected. Pick one from the branch selector in the main sidebar.
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 text-sm text-slate-400">
        Loading agent configuration…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-2xl border border-rose-700/60 bg-rose-950/30 p-6 text-sm text-rose-200">
        Failed to load configuration: {(error as Error).message}
      </div>
    );
  }

  if (!config) {
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 text-sm text-slate-400">
        No configuration found for this garage.
      </div>
    );
  }

  return (
    <>
      {children({ config, save, isSaving, saveError: saveError as Error | null, saveSuccess })}
      {saveError && (
        <div className="fixed bottom-4 right-4 rounded-lg bg-rose-600/90 px-4 py-3 text-sm text-white shadow-lg">
          Save failed: {saveError.message}
        </div>
      )}
      {saveSuccess && !isSaving && (
        <div className="fixed bottom-4 right-4 rounded-lg bg-emerald-600/90 px-4 py-3 text-sm text-white shadow-lg">
          Saved ✓
        </div>
      )}
    </>
  );
}
