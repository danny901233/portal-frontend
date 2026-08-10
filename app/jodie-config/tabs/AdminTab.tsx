'use client';

import { useEffect, useState } from 'react';
import type { AgentConfiguration } from '../../types';
import TabShell from './TabShell';

interface Props {
  config: AgentConfiguration;
  save: (patch: Partial<AgentConfiguration>) => Promise<unknown>;
  isSaving: boolean;
}

type AgentType = 'assist' | 'automate';
type AgentScript = 'receptionmate-agent' | 'receptionmate-agent-v3' | 'tyresoft-agent' | 'Assist-agent' | 'GarageHive-agent' | 'MMH-agent';

const AGENT_TYPE_OPTIONS: { value: AgentType; label: string; description: string }[] = [
  { value: 'assist', label: 'Assist (message-only)', description: 'Agent takes messages, never tries to book' },
  { value: 'automate', label: 'Automate (full booking)', description: 'Agent can book + check diary' },
];

const AGENT_SCRIPT_OPTIONS: { value: AgentScript; label: string; description: string }[] = [
  { value: 'receptionmate-agent-v3', label: 'New Agent', description: 'Enhanced agent with supervisor architecture (Account 1)' },
  { value: 'receptionmate-agent', label: 'Legacy Agent', description: 'Original agent architecture (Account 1)' },
  { value: 'tyresoft-agent', label: 'Tyresoft Agent', description: 'Tyresoft tyre-centre integration (Account 1)' },
  { value: 'Assist-agent', label: 'RMB-Assist (Account 2)', description: 'New assist-mode agent on LiveKit Account 2 — ElevenLabs voice + per-garage rules' },
  { value: 'GarageHive-agent', label: 'RMB-GarageHive', description: 'New GarageHive booking + take-message agent on LiveKit Account 2 — full booking flow, ElevenLabs voice + per-garage rules' },
];

export default function AdminTab({ config, save, isSaving }: Props) {
  const [agentType, setAgentType] = useState<AgentType>(
    (config.agentType as AgentType) ?? 'assist'
  );
  const [agentScript, setAgentScript] = useState<AgentScript>(
    (config.agentScript as AgentScript) ?? 'receptionmate-agent-v3'
  );

  useEffect(() => {
    setAgentType((config.agentType as AgentType) ?? 'assist');
    setAgentScript((config.agentScript as AgentScript) ?? 'receptionmate-agent-v3');
  }, [config]);

  const handleSave = () => {
    void save({ agentType, agentScript });
  };

  return (
    <TabShell
      title="Routing (staff only)"
      description="Which LiveKit agent serves this garage. Changing this updates the SIP dispatch rule immediately."
      onSave={handleSave}
      isSaving={isSaving}
    >
      <div className="rounded-lg border border-amber-700/60 bg-amber-950/30 p-3 text-xs text-amber-800">
        ⚠️ Staff-only tab. Changes here re-route live calls to a different agent.
        Verify with a test call after saving.
      </div>

      <div>
        <label className="mb-2 block text-sm font-medium text-slate-700">
          Agent type
        </label>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {AGENT_TYPE_OPTIONS.map((opt) => {
            const isActive = agentType === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => setAgentType(opt.value)}
                className={`rounded-xl border p-3 text-left transition ${
                  isActive
                    ? 'border-brand-600 bg-brand-100'
                    : 'border-slate-300 bg-slate-50 hover:border-slate-500'
                }`}
              >
                <div className="text-sm font-semibold text-slate-900">{opt.label}</div>
                <div className="mt-0.5 text-xs text-slate-500">{opt.description}</div>
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <label className="mb-2 block text-sm font-medium text-slate-700">
          Agent script (LiveKit dispatch target)
        </label>
        <div className="grid grid-cols-1 gap-2">
          {AGENT_SCRIPT_OPTIONS.map((opt) => {
            const isActive = agentScript === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => setAgentScript(opt.value)}
                className={`rounded-xl border p-3 text-left transition ${
                  isActive
                    ? 'border-brand-600 bg-brand-100'
                    : 'border-slate-300 bg-slate-50 hover:border-slate-500'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold text-slate-900">{opt.label}</div>
                  <code className="rounded bg-white px-2 py-0.5 font-mono text-xs text-slate-500">
                    {opt.value}
                  </code>
                </div>
                <div className="mt-0.5 text-xs text-slate-500">{opt.description}</div>
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-xs text-slate-500">
          Saving with a different agent script triggers the onboarding service to update
          the SIP dispatch rule. Assist-agent routes to LiveKit Account 2; the others stay
          on Account 1.
        </p>
      </div>
    </TabShell>
  );
}
