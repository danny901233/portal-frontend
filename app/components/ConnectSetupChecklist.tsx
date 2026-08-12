'use client';

/**
 * Connect setup checklist — the three things a Connect garage must do before reminders can go out:
 * connect WhatsApp, get a template approved by Meta, and load the customers who are due.
 *
 * Dismissible, but never silently forgotten: dismissing collapses it to a one-line reminder that
 * stays until setup is genuinely finished. Completion is read from /connect/setup-status, which
 * derives each step from real data on every call rather than from a stored "done" flag — so if a
 * garage disconnects WhatsApp or deletes its campaign, the checklist honestly reverts.
 *
 * Once finished it doesn't vanish — it collapses to a "Setup guide" button that reopens the same
 * steps. People come back to this weeks later to remember where WhatsApp is connected or how to
 * upload customers, and a checklist that deletes itself on completion leaves them nowhere to look.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { getSessionToken } from '../lib/auth';

type Steps = {
  whatsapp: { done: boolean; label: string | null };
  template: { done: boolean; submitted: number; approved: number; rejected: number; drafts: number };
  contacts: { done: boolean; campaigns: number };
};
type Status = { applicable: boolean; complete: boolean; remaining: number; steps: Steps };

const dismissKey = (garageId: string) => `rm_connect_setup_dismissed_${garageId}`;

export default function ConnectSetupChecklist({ garageId }: { garageId: string | null }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [dismissed, setDismissed] = useState(true); // assume dismissed until we've read storage
  /** Completed setup, reopened on purpose from the "Setup guide" button. */
  const [reopenedComplete, setReopenedComplete] = useState(false);

  useEffect(() => {
    if (!garageId) return;
    try {
      setDismissed(localStorage.getItem(dismissKey(garageId)) === '1');
    } catch {
      setDismissed(false);
    }
  }, [garageId]);

  const load = useCallback(async () => {
    if (!garageId) return;
    try {
      const token = getSessionToken();
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/connect/setup-status/${garageId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      setStatus(await res.json());
    } catch {
      /* leave null — render nothing rather than a misleading checklist */
    }
  }, [garageId]);

  useEffect(() => { void load(); }, [load]);

  // Only for messaging garages.
  if (!status || !status.applicable) return null;

  const dismiss = () => {
    setDismissed(true);
    try { if (garageId) localStorage.setItem(dismissKey(garageId), '1'); } catch { /* ignore */ }
  };
  const reopen = () => {
    setDismissed(false);
    try { if (garageId) localStorage.removeItem(dismissKey(garageId)); } catch { /* ignore */ }
  };

  const { steps, remaining } = status;
  const done = 3 - remaining;

  // Finished: a quiet way back in, rather than nothing at all.
  if (status.complete && !reopenedComplete) {
    return (
      <button
        onClick={() => setReopenedComplete(true)}
        className="flex w-full items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-left transition hover:bg-slate-50"
      >
        <span className="text-sm text-slate-600">
          <span className="mr-1.5 text-green-600">✓</span>
          <strong className="text-slate-900">Setup complete.</strong> Your reminders can go out.
        </span>
        <span className="shrink-0 text-xs font-semibold text-blue-600 underline underline-offset-2">Setup guide</span>
      </button>
    );
  }

  if (dismissed && !status.complete) {
    return (
      <button
        onClick={reopen}
        className="flex w-full items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-left transition hover:bg-amber-100"
      >
        <span className="text-sm text-amber-900">
          <strong>Setup {done}/3.</strong> Your reminders can’t go out until setup is finished.
        </span>
        <span className="shrink-0 text-xs font-semibold text-amber-800 underline underline-offset-2">Finish setup</span>
      </button>
    );
  }

  const items = [
    {
      done: steps.whatsapp.done,
      title: 'Connect your WhatsApp number',
      body: steps.whatsapp.done
        ? `Connected${steps.whatsapp.label ? ` — ${steps.whatsapp.label}` : ''}.`
        : 'Link your WhatsApp Business account so the AI can message your customers. You can create one during setup if you don’t have one.',
      href: '/agent-setup/messaging',
      cta: 'Connect WhatsApp',
    },
    {
      done: steps.template.done,
      title: 'Submit a reminder template for approval',
      body: steps.template.done
        ? `${steps.template.submitted} submitted${steps.template.approved ? `, ${steps.template.approved} approved by Meta` : ' — waiting on Meta'}.`
        : steps.template.rejected > 0
          ? `${steps.template.rejected} template was rejected by Meta and needs editing before it can be sent again.`
          : `Your MOT and service reminders are already written${steps.template.drafts ? ` (${steps.template.drafts} drafts ready)` : ''} — review the wording and submit them. Meta has to approve a template before it can be sent.`,
      href: '/outbound#templates',
      cta: steps.template.rejected > 0 ? 'Fix template' : 'Review and submit',
    },
    {
      done: steps.contacts.done,
      title: 'Add the customers who are due',
      body: steps.contacts.done
        ? `${steps.contacts.campaigns} campaign${steps.contacts.campaigns === 1 ? '' : 's'} created.`
        : 'Upload everyone in your book, or as far ahead as your system will export — at least the next 60 days. Nobody is messaged when the file lands: each customer is contacted 30 days before their own due date, chased at 14 days and again at 3 if they haven’t replied. Uploading only what’s due in the next few days means the reminder arrives too late to book. If your diary system is connected we can pull these for you automatically instead.',
      href: '/outbound',
      cta: 'Upload customers',
    },
  ];

  return (
    <div className="overflow-hidden rounded-2xl border border-amber-200 bg-gradient-to-br from-amber-50 to-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-bold text-slate-900">
            {status.complete ? 'Your reminder setup' : 'Finish setting up your reminders'}
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            {status.complete
              ? 'All three steps are done. Here they are again if you need to change anything.'
              : `${done} of 3 done — your MOT and service reminders start going out once these are complete.`}
          </p>
        </div>
        <button
          onClick={() => (status.complete ? setReopenedComplete(false) : dismiss())}
          className="shrink-0 rounded-full px-3 py-1 text-xs font-semibold text-slate-500 transition hover:bg-white hover:text-slate-700"
        >
          {status.complete ? 'Close' : 'Dismiss'}
        </button>
      </div>

      <ol className="mt-4 space-y-3">
        {items.map((it, i) => (
          <li key={it.title} className={`flex items-start gap-3 rounded-xl border p-3 ${it.done ? 'border-emerald-200 bg-emerald-50/60' : 'border-slate-200 bg-white'}`}>
            <span className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-bold ${it.done ? 'bg-emerald-600 text-white' : 'bg-slate-200 text-slate-600'}`}>
              {it.done ? '✓' : i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className={`text-sm font-semibold ${it.done ? 'text-emerald-900' : 'text-slate-900'}`}>{it.title}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-slate-600">{it.body}</p>
            </div>
            {!it.done && (
              <Link href={it.href} className="shrink-0 self-center rounded-full bg-brand-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-brand-700">
                {it.cta}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
