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
      notifHeading: 'Notifications',
      notifDesc: 'Get alerted when customers message you on chat.',
      scopeLabel: 'When to notify',
      scopeOff: 'Off — no notifications',
      scopeEscalated: 'Only when a chat is handed to a human',
      scopeAll: 'Every message (including those handled by the AI)',
      methodLabel: 'How to notify',
      emailMethod: 'Email',
      emailHint: 'Sent to your notification email addresses.',
      smsMethod: 'SMS',
      smsCharge: '£0.20 per SMS',
      phoneLabel: 'SMS number',
      phoneHint: 'Where to text alerts. Use full international format (e.g. +447123456789).',
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
      notifHeading: 'Notifications',
      notifDesc: 'Soyez alerté lorsque des clients vous écrivent sur le chat.',
      scopeLabel: 'Quand notifier',
      scopeOff: 'Désactivé — aucune notification',
      scopeEscalated: "Uniquement lorsqu'un chat est transféré à un humain",
      scopeAll: "Chaque message (y compris ceux gérés par l'IA)",
      methodLabel: 'Comment notifier',
      emailMethod: 'E-mail',
      emailHint: 'Envoyé à vos adresses e-mail de notification.',
      smsMethod: 'SMS',
      smsCharge: '0,20 £ par SMS',
      phoneLabel: 'Numéro SMS',
      phoneHint: 'Où envoyer les alertes. Format international complet (p. ex. +447123456789).',
    },
  }[lang];

  const [messagingHumanHandoff, setMessagingHumanHandoff] = useState(
    () => config.messagingHumanHandoff ?? true,
  );
  const [messagingHandoffMessage, setMessagingHandoffMessage] = useState(
    () => config.messagingHandoffMessage ?? '',
  );
  const [notifyScope, setNotifyScope] = useState<'off' | 'escalated' | 'all'>(
    () => config.messagingNotifyScope ?? 'off',
  );
  const [notifyEmail, setNotifyEmail] = useState(() => config.messagingNotifyEmail ?? false);
  const [notifySms, setNotifySms] = useState(() => config.messagingNotifySms ?? false);
  const [notifyPhone, setNotifyPhone] = useState(() => config.messagingNotifyPhone ?? '');

  const handleSave = () => {
    void save({
      messagingHumanHandoff,
      messagingHandoffMessage: messagingHandoffMessage.trim() || null,
      messagingNotifyScope: notifyScope,
      messagingNotifyEmail: notifyEmail,
      messagingNotifySms: notifySms,
      messagingNotifyPhone: notifyPhone.trim() || null,
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

      {/* Notifications */}
      <div className="border-t border-slate-200 pt-5">
        <p className="text-sm font-semibold text-slate-900">{c.notifHeading}</p>
        <p className="mt-0.5 text-xs text-slate-500">{c.notifDesc}</p>

        <fieldset className="mt-3">
          <legend className="mb-1 block text-sm font-medium text-slate-700">{c.scopeLabel}</legend>
          <div className="space-y-2">
            {([
              ['off', c.scopeOff],
              ['escalated', c.scopeEscalated],
              ['all', c.scopeAll],
            ] as const).map(([value, label]) => (
              <label key={value} className="flex items-center gap-3 text-sm text-slate-800">
                <input
                  type="radio"
                  name="messagingNotifyScope"
                  checked={notifyScope === value}
                  onChange={() => setNotifyScope(value)}
                  className="h-4 w-4 border-slate-300 text-brand-600 focus:ring-brand-600"
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>

        {notifyScope !== 'off' && (
          <div className="mt-4">
            <p className="mb-1 block text-sm font-medium text-slate-700">{c.methodLabel}</p>
            <div className="space-y-2">
              <label className="flex items-center gap-3 text-sm text-slate-800">
                <input
                  type="checkbox"
                  checked={notifyEmail}
                  onChange={(e) => setNotifyEmail(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-600"
                />
                <span>
                  {c.emailMethod}
                  <span className="ml-1 text-xs text-slate-500">— {c.emailHint}</span>
                </span>
              </label>
              <label className="flex items-center gap-3 text-sm text-slate-800">
                <input
                  type="checkbox"
                  checked={notifySms}
                  onChange={(e) => setNotifySms(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-600"
                />
                <span>
                  {c.smsMethod}
                  <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                    {c.smsCharge}
                  </span>
                </span>
              </label>
            </div>

            {notifySms && (
              <div className="mt-3">
                <label className="mb-1 block text-sm font-medium text-slate-700">{c.phoneLabel}</label>
                <input
                  type="tel"
                  value={notifyPhone}
                  onChange={(e) => setNotifyPhone(e.target.value)}
                  placeholder="+44 7123 456789"
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
                />
                <p className="mt-1 text-xs text-slate-500">{c.phoneHint}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </TabShell>
  );
}
