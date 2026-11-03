/**
 * Which agent scripts read a garage's diary through the shared adapters.
 *
 * The supervisor agent replaces the unified one and vendored the same adapters, so every
 * credential panel, capability gate and booking toggle that applied to `unified-agent` applies
 * to it unchanged. Anything else answers false, which is what it did before the supervisor
 * existed — a new name must never switch a panel on by accident.
 */
export const DIARY_ADAPTER_SCRIPTS = ['unified-agent', 'supervisor-agent'] as const;

export function usesDiaryAdapters(agentScript?: string | null): boolean {
  return DIARY_ADAPTER_SCRIPTS.includes((agentScript || '').trim() as (typeof DIARY_ADAPTER_SCRIPTS)[number]);
}
