'use client';

import { useEffect, useState } from 'react';
import type { AgentConfiguration } from '../../types';
import TabShell from './TabShell';

interface Props {
  config: AgentConfiguration;
  save: (patch: Partial<AgentConfiguration>) => Promise<unknown>;
  isSaving: boolean;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function NotificationsTab({ config, save, isSaving }: Props) {
  const [emails, setEmails] = useState<string[]>(config.notificationEmails ?? []);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setEmails(config.notificationEmails ?? []);
  }, [config]);

  const addEmail = () => {
    const trimmed = draft.trim().toLowerCase();
    if (!trimmed) {
      setError('Type an email address first.');
      return;
    }
    if (!EMAIL_RE.test(trimmed)) {
      setError('That doesn’t look like a valid email address.');
      return;
    }
    if (emails.includes(trimmed)) {
      setError('That email is already on the list.');
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
      title="Notifications"
      description="Decide who hears about each call. After every call ends, a summary email is sent to the addresses below."
      onSave={handleSave}
      isSaving={isSaving}
    >
      <div>
        <label className="mb-1 block text-sm font-medium text-slate-700">Add a notification email</label>
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
            Add
          </button>
        </div>
        {error ? (
          <p className="mt-2 text-xs text-rose-600">{error}</p>
        ) : (
          <p className="mt-2 text-xs text-slate-500">
            Press Enter or comma to add. Add as many addresses as you like — everyone gets the same summary.
          </p>
        )}
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-medium text-slate-700">Recipients</span>
          <span className="text-xs text-slate-500">
            {emails.length === 0
              ? 'No-one will be notified'
              : `${emails.length} address${emails.length === 1 ? '' : 'es'}`}
          </span>
        </div>
        {emails.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-center text-xs text-slate-500">
            No recipients yet. Add at least one address above to receive call summaries.
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
                  aria-label={`Remove ${email}`}
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
        <p className="font-semibold text-slate-800">What does a notification look like?</p>
        <p className="mt-1">
          Each email includes the caller&rsquo;s number, the call summary, whether a booking was captured, and a link
          to the full transcript. Sent within a minute of the call ending.
        </p>
      </div>
    </TabShell>
  );
}
