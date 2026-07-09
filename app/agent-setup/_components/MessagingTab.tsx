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

/**
 * Messaging (chat) agent behaviour. Independent of the voice-side transfer
 * settings: some garages are happy for the chat agent to promise a human will
 * follow up, others never want it to — they'd rather it politely deflects and
 * keeps the conversation self-serve. `messagingHumanHandoff` off swaps every
 * "I'll get someone to help" for a polite close (optionally the garage's own
 * wording in `messagingHandoffMessage`).
 */
export default function MessagingTab({ config, save, isSaving }: Props) {
  // Lazy initializer — captures config on first mount. PageGate keys the parent
  // on garageId so this fully remounts on garage switch (no effect-driven reset).
  const lang = useLang();
  const c = {
    en: {
      title: 'Messaging agent',
      description:
        'How the chat agent behaves when a customer asks to speak to a real person. Turn handovers off if you never want the chat to promise a callback or transfer to a human.',
      toggleLabel: 'Allow the chat agent to hand over to a human',
      toggleHint:
        "When ticked, the agent can tell customers a member of the team will follow up. Untick to keep every chat AI-handled — it'll politely explain no one's available instead.",
      msgLabel: 'Message when a human is unavailable',
      msgHint:
        'Optional. The exact line the agent sends when someone asks for a human and handovers are off. Leave blank to fall back to your phone/email contact details.',
      msgPlaceholder:
        "Thanks for your message! Our team isn't available on chat, but I can help you book, get a quote, or answer questions right here.",
    },
    fr: {
      title: 'Agent de messagerie',
      description:
        "Comment l'agent de chat se comporte lorsqu'un client demande à parler à une vraie personne. Désactivez les transferts si vous ne voulez jamais que le chat promette un rappel ou un transfert vers un humain.",
      toggleLabel: "Autoriser l'agent de chat à transférer à un humain",
      toggleHint:
        "Lorsque cette case est cochée, l'agent peut dire aux clients qu'un membre de l'équipe fera un suivi. Décochez pour que chaque chat reste géré par l'IA — il expliquera poliment que personne n'est disponible.",
      msgLabel: "Message lorsqu'aucun humain n'est disponible",
      msgHint:
        "Facultatif. La phrase exacte que l'agent envoie lorsqu'on demande un humain et que les transferts sont désactivés. Laissez vide pour utiliser vos coordonnées téléphone/e-mail.",
      msgPlaceholder:
        "Merci pour votre message ! Notre équipe n'est pas disponible sur le chat, mais je peux vous aider à réserver, obtenir un devis ou répondre à vos questions ici même.",
    },
  }[lang];

  const [messagingHumanHandoff, setMessagingHumanHandoff] = useState(
    () => config.messagingHumanHandoff ?? true,
  );
  const [messagingHandoffMessage, setMessagingHandoffMessage] = useState(
    () => config.messagingHandoffMessage ?? '',
  );

  const handleSave = () => {
    void save({
      messagingHumanHandoff,
      messagingHandoffMessage: messagingHandoffMessage.trim() || null,
    });
  };

  return (
    <TabShell
      title={c.title}
      description={c.description}
      onSave={handleSave}
      isSaving={isSaving}
    >
      <label className="flex items-start gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
        <input
          type="checkbox"
          checked={messagingHumanHandoff}
          onChange={(e) => setMessagingHumanHandoff(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-600"
        />
        <div>
          <p className="text-sm font-medium text-slate-900">{c.toggleLabel}</p>
          <p className="mt-0.5 text-xs text-slate-500">{c.toggleHint}</p>
        </div>
      </label>

      {!messagingHumanHandoff && (
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">
            {c.msgLabel}
          </label>
          <textarea
            value={messagingHandoffMessage}
            onChange={(e) => setMessagingHandoffMessage(e.target.value)}
            rows={3}
            placeholder={c.msgPlaceholder}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
          />
          <p className="mt-1 text-xs text-slate-500">{c.msgHint}</p>
        </div>
      )}
    </TabShell>
  );
}
