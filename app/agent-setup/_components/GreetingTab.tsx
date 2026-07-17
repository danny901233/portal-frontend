'use client';

import { useEffect, useState } from 'react';
import type { AgentConfiguration } from '../../types';
import { useLang } from '@/app/i18n/LocaleProvider';
import TabShell from './TabShell';

interface Props {
  config: AgentConfiguration;
  save: (patch: Partial<AgentConfiguration>) => Promise<unknown>;
  isSaving: boolean;
}

export default function GreetingTab({ config, save, isSaving }: Props) {
  const lang = useLang();
  const c = {
    en: {
      title: 'Greeting',
      description: 'The first thing the agent says when it answers a call. Keep it warm and short.',
      label: 'Greeting line',
      placeholder: "Hi, you've reached Acme Auto Centre — how can I help?",
      hint: 'One or two short sentences works best. Leave blank to use our default ("Hi, thanks for calling — how can I help?").',
    },
    fr: {
      title: "Message d'accueil",
      description:
        "La première chose que l'agent dit lorsqu'il répond à un appel. Restez chaleureux et bref.",
      label: "Ligne d'accueil",
      placeholder: 'Bonjour, vous êtes bien chez Acme Auto Centre — comment puis-je vous aider ?',
      hint: 'Une ou deux phrases courtes fonctionnent le mieux. Laissez vide pour utiliser notre valeur par défaut (« Bonjour, merci de votre appel — comment puis-je vous aider ? »).',
    },
  }[lang];
  const [greetingLine, setGreetingLine] = useState(config.greetingLine ?? '');

  useEffect(() => {
    setGreetingLine(config.greetingLine ?? '');
  }, [config.greetingLine]);

  const handleSave = () => {
    void save({ greetingLine: greetingLine.trim() });
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
        <textarea
          value={greetingLine}
          onChange={(e) => setGreetingLine(e.target.value)}
          rows={3}
          placeholder={c.placeholder}
          className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
        />
        <p className="mt-1 text-xs text-slate-500">
          {c.hint}
        </p>
      </div>
    </TabShell>
  );
}
