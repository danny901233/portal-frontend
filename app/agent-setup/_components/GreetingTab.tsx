'use client';

import { useEffect, useState } from 'react';
import type { AgentConfiguration } from '../../types';
import TabShell from './TabShell';

interface Props {
  config: AgentConfiguration;
  save: (patch: Partial<AgentConfiguration>) => Promise<unknown>;
  isSaving: boolean;
}

export default function GreetingTab({ config, save, isSaving }: Props) {
  const [greetingLine, setGreetingLine] = useState(config.greetingLine ?? '');

  useEffect(() => {
    setGreetingLine(config.greetingLine ?? '');
  }, [config.greetingLine]);

  const handleSave = () => {
    void save({ greetingLine: greetingLine.trim() });
  };

  return (
    <TabShell
      title="Greeting"
      description="The first thing the agent says when it answers a call. Keep it warm and short."
      onSave={handleSave}
      isSaving={isSaving}
    >
      <div>
        <label className="mb-1 block text-sm font-medium text-slate-700">Greeting line</label>
        <textarea
          value={greetingLine}
          onChange={(e) => setGreetingLine(e.target.value)}
          rows={3}
          placeholder="Hi, you've reached Acme Auto Centre — how can I help?"
          className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
        />
        <p className="mt-1 text-xs text-slate-500">
          One or two short sentences works best. Leave blank to use our default ("Hi, thanks for calling — how can I help?").
        </p>
      </div>
    </TabShell>
  );
}
