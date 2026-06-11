'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchAgentConfiguration, updateAgentConfiguration } from '../lib/api';
import { getGarageId } from '../lib/auth';
import type { AgentConfiguration } from '../types';

/**
 * Shared data layer for every /agent-setup/* page. Pulls the current
 * garageId from auth (set by AppShell branch selector), fetches the
 * AgentConfiguration via TanStack Query, and exposes a save mutation
 * that merges a patch onto the current config and PUTs the whole thing.
 *
 * Each sub-page only owns the field group it edits; the rest passes through.
 */
export function useAgentSetup() {
  const garageId = getGarageId();
  const queryClient = useQueryClient();

  const configQuery = useQuery({
    enabled: Boolean(garageId),
    queryKey: ['agent-config', garageId],
    queryFn: async () => fetchAgentConfiguration(garageId ?? undefined),
  });

  const saveMutation = useMutation({
    mutationFn: async (patch: Partial<AgentConfiguration>) => {
      const current = configQuery.data?.configuration;
      if (!current) throw new Error('Config not loaded yet');
      const merged = { ...current, ...patch } as AgentConfiguration;
      return updateAgentConfiguration(merged, garageId ?? undefined);
    },
    onSuccess: (data) => {
      queryClient.setQueryData(['agent-config', garageId], data);
    },
  });

  return {
    garageId,
    config: configQuery.data?.configuration ?? null,
    isLoading: configQuery.isLoading,
    error: configQuery.error,
    save: saveMutation.mutateAsync,
    isSaving: saveMutation.isPending,
    saveError: saveMutation.error,
    saveSuccess: saveMutation.isSuccess,
  };
}
