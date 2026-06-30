'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import api, {
  fetchGarages,
  fetchAgentConfiguration,
  updateAgentConfiguration,
} from '../lib/api';
import type { AgentConfiguration } from '../types';
import IdentityTab from './tabs/IdentityTab';
import VoiceTab from './tabs/VoiceTab';
import BehaviorTab from './tabs/BehaviorTab';
import HoursTab from './tabs/HoursTab';
import CaptureTab from './tabs/CaptureTab';
import BookingTab from './tabs/BookingTab';
import IntegrationsTab from './tabs/IntegrationsTab';
import AdminTab from './tabs/AdminTab';

type TabKey =
  | 'identity'
  | 'voice'
  | 'behavior'
  | 'hours'
  | 'capture'
  | 'booking'
  | 'integrations'
  | 'admin';

interface TabDef {
  key: TabKey;
  label: string;
  description: string;
  staffOnly?: boolean;
}

const TABS: TabDef[] = [
  { key: 'identity', label: 'Identity', description: 'Branch name + contact' },
  { key: 'voice', label: 'Voice & sound', description: 'How the agent sounds' },
  { key: 'behavior', label: 'Behavior & rules', description: 'Greeting, tone, custom rules' },
  { key: 'hours', label: 'Opening hours', description: 'When the agent answers' },
  { key: 'capture', label: 'Information capture', description: 'What to collect from callers' },
  { key: 'booking', label: 'Booking behavior', description: 'How bookings are handled' },
  { key: 'integrations', label: 'Integrations', description: 'Diary + CRM connections' },
  { key: 'admin', label: 'Routing', description: 'Agent assignment (staff only)', staffOnly: true },
];

export default function JodieConfigPage() {
  const search = useSearchParams();
  const queryClient = useQueryClient();

  const garageIdFromUrl = search.get('garageId') ?? '';
  const [garageId, setGarageId] = useState(garageIdFromUrl);
  const [activeTab, setActiveTab] = useState<TabKey>('identity');

  const meQuery = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const { data } = await api.get<{ user: { role: string; email: string } | null }>(
        '/api/auth/me'
      );
      return data;
    },
  });

  const garagesQuery = useQuery({
    queryKey: ['garages'],
    queryFn: fetchGarages,
  });

  const configQuery = useQuery({
    enabled: Boolean(garageId),
    queryKey: ['agent-config', garageId],
    queryFn: async () => fetchAgentConfiguration(garageId),
  });

  const saveMutation = useMutation({
    mutationFn: async (patch: Partial<AgentConfiguration>) => {
      if (!garageId) throw new Error('No garage selected');
      const current = configQuery.data?.configuration;
      if (!current) throw new Error('Config not loaded');
      const merged = { ...current, ...patch } as AgentConfiguration;
      return updateAgentConfiguration(merged, garageId);
    },
    onSuccess: (data) => {
      queryClient.setQueryData(['agent-config', garageId], data);
    },
  });

  const isStaff = meQuery.data?.user?.role === 'RECEPTIONMATE_STAFF';
  const visibleTabs = useMemo(
    () => TABS.filter((t) => !t.staffOnly || isStaff),
    [isStaff]
  );

  useEffect(() => {
    if (garageIdFromUrl && garageIdFromUrl !== garageId) {
      setGarageId(garageIdFromUrl);
    }
  }, [garageIdFromUrl, garageId]);

  const garages = (garagesQuery.data?.garages ?? []) as Array<{ id: string; name: string }>;
  const config = configQuery.data?.configuration ?? null;

  return (
    <div className="min-h-screen bg-white px-6 py-8 text-slate-900">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="space-y-3">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold">Agent Configuration</h1>
            <span className="rounded bg-purple-600/20 px-2 py-0.5 text-xs font-medium text-purple-300">
              Jodie-Inspired · Preview
            </span>
          </div>
          <p className="text-sm text-slate-500">
            Configure how the AI agent behaves for this garage. Each tab saves
            independently — changes apply to the next call.
          </p>

          {/* Garage selector */}
          <div className="flex items-center gap-3">
            <label className="text-sm text-slate-600">Garage:</label>
            <select
              value={garageId}
              onChange={(e) => setGarageId(e.target.value)}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
            >
              <option value="">Select a garage…</option>
              {garages.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
            {configQuery.isLoading && (
              <span className="text-xs text-slate-500">loading config…</span>
            )}
            {configQuery.isError && (
              <span className="text-xs text-rose-700">
                failed to load: {(configQuery.error as Error)?.message}
              </span>
            )}
          </div>
        </header>

        {garageId && config ? (
          <>
            {/* Tab bar */}
            <nav className="flex flex-wrap gap-2 border-b border-slate-200 pb-3">
              {visibleTabs.map((tab) => {
                const isActive = activeTab === tab.key;
                return (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => setActiveTab(tab.key)}
                    className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
                      isActive
                        ? 'bg-brand-600 text-white shadow-lg shadow-sky-500/20'
                        : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                    }`}
                  >
                    <div>{tab.label}</div>
                    <div
                      className={`mt-0.5 text-xs ${
                        isActive ? 'text-brand-700' : 'text-slate-500'
                      }`}
                    >
                      {tab.description}
                    </div>
                  </button>
                );
              })}
            </nav>

            {/* Tab content */}
            <div>
              {activeTab === 'identity' && (
                <IdentityTab
                  config={config}
                  save={(patch) => saveMutation.mutateAsync(patch)}
                  isSaving={saveMutation.isPending}
                />
              )}
              {activeTab === 'voice' && (
                <VoiceTab
                  config={config}
                  save={(patch) => saveMutation.mutateAsync(patch)}
                  isSaving={saveMutation.isPending}
                />
              )}
              {activeTab === 'behavior' && (
                <BehaviorTab
                  config={config}
                  save={(patch) => saveMutation.mutateAsync(patch)}
                  isSaving={saveMutation.isPending}
                />
              )}
              {activeTab === 'hours' && (
                <HoursTab
                  config={config}
                  save={(patch) => saveMutation.mutateAsync(patch)}
                  isSaving={saveMutation.isPending}
                />
              )}
              {activeTab === 'capture' && (
                <CaptureTab
                  config={config}
                  save={(patch) => saveMutation.mutateAsync(patch)}
                  isSaving={saveMutation.isPending}
                />
              )}
              {activeTab === 'booking' && (
                <BookingTab
                  config={config}
                  save={(patch) => saveMutation.mutateAsync(patch)}
                  isSaving={saveMutation.isPending}
                />
              )}
              {activeTab === 'integrations' && (
                <IntegrationsTab
                  config={config}
                  save={(patch) => saveMutation.mutateAsync(patch)}
                  isSaving={saveMutation.isPending}
                />
              )}
              {activeTab === 'admin' && isStaff && (
                <AdminTab
                  config={config}
                  save={(patch) => saveMutation.mutateAsync(patch)}
                  isSaving={saveMutation.isPending}
                />
              )}
            </div>
          </>
        ) : (
          <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-slate-500">
            {garagesQuery.isLoading
              ? 'Loading garages…'
              : 'Select a garage above to configure its agent.'}
          </div>
        )}

        {saveMutation.isError && (
          <div className="fixed bottom-4 right-4 rounded-lg bg-rose-600/90 px-4 py-3 text-sm text-white shadow-lg">
            Save failed: {(saveMutation.error as Error)?.message}
          </div>
        )}
        {saveMutation.isSuccess && !saveMutation.isPending && (
          <div className="fixed bottom-4 right-4 rounded-lg bg-emerald-600/90 px-4 py-3 text-sm text-white shadow-lg">
            Saved ✓
          </div>
        )}
      </div>
    </div>
  );
}
