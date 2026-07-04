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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function NotificationsTab({ config, save, isSaving }: Props) {
  const lang = useLang();
  const c = {
    en: {
      title: 'Notifications',
      description:
        'Decide who hears about each call. After every call ends, a summary email is sent to the addresses below.',
      errTypeFirst: 'Type an email address first.',
      errInvalid: 'That doesn’t look like a valid email address.',
      errDuplicate: 'That email is already on the list.',
      addLabel: 'Add a notification email',
      addButton: 'Add',
      addHint:
        'Press Enter or comma to add. Add as many addresses as you like — everyone gets the same summary.',
      recipients: 'Recipients',
      noneNotified: 'No-one will be notified',
      addressCount: (n: number) => `${n} address${n === 1 ? '' : 'es'}`,
      emptyRecipients: 'No recipients yet. Add at least one address above to receive call summaries.',
      removeAria: (email: string) => `Remove ${email}`,
      whatTitle: 'What does a notification look like?',
      whatBody:
        'Each email includes the caller’s number, the call summary, whether a booking was captured, and a link to the full transcript. Sent within a minute of the call ending.',
    },
    fr: {
      title: 'Notifications',
      description:
        'Décidez qui est informé de chaque appel. Après chaque fin d’appel, un email de récapitulatif est envoyé aux adresses ci-dessous.',
      errTypeFirst: 'Saisissez d’abord une adresse email.',
      errInvalid: 'Cela ne ressemble pas à une adresse email valide.',
      errDuplicate: 'Cet email figure déjà dans la liste.',
      addLabel: 'Ajouter un email de notification',
      addButton: 'Ajouter',
      addHint:
        'Appuyez sur Entrée ou virgule pour ajouter. Ajoutez autant d’adresses que vous le souhaitez — tout le monde reçoit le même récapitulatif.',
      recipients: 'Destinataires',
      noneNotified: 'Personne ne sera notifié',
      addressCount: (n: number) => `${n} adresse${n === 1 ? '' : 's'}`,
      emptyRecipients:
        'Aucun destinataire pour l’instant. Ajoutez au moins une adresse ci-dessus pour recevoir les récapitulatifs d’appel.',
      removeAria: (email: string) => `Supprimer ${email}`,
      whatTitle: 'À quoi ressemble une notification ?',
      whatBody:
        'Chaque email inclut le numéro de l’appelant, le récapitulatif de l’appel, si une réservation a été enregistrée, et un lien vers la transcription complète. Envoyé dans la minute suivant la fin de l’appel.',
    },
  }[lang];
  const [emails, setEmails] = useState<string[]>(config.notificationEmails ?? []);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setEmails(config.notificationEmails ?? []);
  }, [config]);

  const addEmail = () => {
    const trimmed = draft.trim().toLowerCase();
    if (!trimmed) {
      setError(c.errTypeFirst);
      return;
    }
    if (!EMAIL_RE.test(trimmed)) {
      setError(c.errInvalid);
      return;
    }
    if (emails.includes(trimmed)) {
      setError(c.errDuplicate);
      return;
    }
    setEmails((prev) => [...prev, trimmed]);
    setDraft('');
    setError(null);
  };

  const removeEmail = (email: string) => {
    setEmails((prev) => prev.filter((e) => e !== email));
    setError(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addEmail();
    }
  };

  const handleSave = () => {
    void save({ notificationEmails: emails });
  };

  return (
    <TabShell
      title={c.title}
      description={c.description}
      onSave={handleSave}
      isSaving={isSaving}
    >
      <div>
        <label className="mb-1 block text-sm font-medium text-slate-700">{c.addLabel}</label>
        <div className="flex gap-2">
          <input
            type="email"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="manager@garage.co.uk"
            className="flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600"
          />
          <button
            type="button"
            onClick={addEmail}
            className="rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-brand-700"
          >
            {c.addButton}
          </button>
        </div>
        {error ? (
          <p className="mt-2 text-xs text-rose-600">{error}</p>
        ) : (
          <p className="mt-2 text-xs text-slate-500">
            {c.addHint}
          </p>
        )}
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-medium text-slate-700">{c.recipients}</span>
          <span className="text-xs text-slate-500">
            {emails.length === 0
              ? c.noneNotified
              : c.addressCount(emails.length)}
          </span>
        </div>
        {emails.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-center text-xs text-slate-500">
            {c.emptyRecipients}
          </div>
        ) : (
          <ul className="space-y-2">
            {emails.map((email) => (
              <li
                key={email}
                className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm"
              >
                <span className="truncate">{email}</span>
                <button
                  type="button"
                  onClick={() => removeEmail(email)}
                  aria-label={c.removeAria(email)}
                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-slate-200 text-slate-500 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-xs text-slate-600">
        <p className="font-semibold text-slate-800">{c.whatTitle}</p>
        <p className="mt-1">
          {c.whatBody}
        </p>
      </div>
    </TabShell>
  );
}
