'use client';

import { useEffect, useState } from 'react';
import { useLang } from '@/app/i18n/LocaleProvider';

type Vote = 'up' | 'down' | null;

export default function HelpfulVote({ articleKey }: { articleKey: string }) {
  const [vote, setVote] = useState<Vote>(null);
  const [showFollowup, setShowFollowup] = useState(false);
  const storageKey = `help-vote:${articleKey}`;
  const lang = useLang();
  const c = {
    en: {
      gladItHelped: 'Glad it helped.',
      thanksSignal: "Thanks for the signal — we'll improve this article.",
      followupLead: "If you've got a minute, tell us what was missing:",
      emailUs: 'email us',
      wasHelpful: 'Was this helpful?',
      yes: 'Yes',
      no: 'No',
    },
    fr: {
      gladItHelped: 'Ravis que cela vous ait aidé.',
      thanksSignal: 'Merci pour votre retour — nous améliorerons cet article.',
      followupLead: "Si vous avez une minute, dites-nous ce qui manquait :",
      emailUs: 'écrivez-nous',
      wasHelpful: 'Cet article vous a-t-il été utile ?',
      yes: 'Oui',
      no: 'Non',
    },
  }[lang];

  // Restore previous vote from localStorage so we don't re-prompt
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = window.localStorage.getItem(storageKey);
    if (stored === 'up' || stored === 'down') setVote(stored as Vote);
  }, [storageKey]);

  const cast = (value: 'up' | 'down') => {
    setVote(value);
    if (typeof window !== 'undefined') {
      try { window.localStorage.setItem(storageKey, value); } catch { /* quota — ignore */ }
    }
    if (value === 'down') setShowFollowup(true);
  };

  if (vote) {
    return (
      <div className="mt-12 rounded-2xl border border-slate-200 bg-slate-50/50 px-6 py-5">
        <div className="flex items-center gap-3">
          <span className="text-2xl" aria-hidden>{vote === 'up' ? '🙌' : '🙏'}</span>
          <div className="flex-1">
            <p className="text-sm font-semibold text-slate-900">
              {vote === 'up' ? c.gladItHelped : c.thanksSignal}
            </p>
            {vote === 'down' && showFollowup ? (
              <p className="mt-1 text-sm text-slate-600">
                {c.followupLead}{' '}
                <a
                  href={`mailto:hello@receptionmate.co.uk?subject=Help%20article%20feedback%3A%20${encodeURIComponent(articleKey)}`}
                  className="font-medium text-brand-600 hover:text-brand-700"
                >
                  {c.emailUs}
                </a>.
              </p>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-12 flex flex-col items-start gap-3 rounded-2xl border border-slate-200 bg-slate-50/50 px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm font-semibold text-slate-900">{c.wasHelpful}</p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => cast('up')}
          className="inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-700"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6.633 10.5c.806 0 1.533-.446 2.031-1.08a9.041 9.041 0 012.861-2.4c.723-.384 1.35-.956 1.653-1.715a4.498 4.498 0 00.322-1.672V2.75a.75.75 0 01.75-.75 2.25 2.25 0 012.25 2.25c0 1.152-.26 2.243-.723 3.218-.266.558.107 1.282.725 1.282m0 0h3.126c1.026 0 1.945.694 2.054 1.715.045.422.068.85.068 1.285a11.95 11.95 0 01-2.649 7.521c-.388.482-.987.729-1.605.729H13.48c-.483 0-.964-.078-1.423-.23l-3.114-1.04a4.501 4.501 0 00-1.423-.23H5.904m10.598-9.75H14.25M5.904 18.75c.083.205.173.405.27.602.197.4-.078.898-.523.898h-.908c-.889 0-1.713-.518-1.972-1.368a12 12 0 01-.521-3.507c0-1.553.295-3.036.831-4.398C3.387 10.203 4.167 9.75 5 9.75h1.053c.472 0 .745.556.5.96a8.958 8.958 0 00-1.302 4.665c0 1.194.232 2.333.654 3.375z" />
          </svg>
          {c.yes}
        </button>
        <button
          type="button"
          onClick={() => cast('down')}
          className="inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-rose-300 hover:bg-rose-50 hover:text-rose-700"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 15h2.25m8.024-9.75c.011.05.028.1.052.148.591 1.2.924 2.55.924 3.977a8.96 8.96 0 01-.999 4.125m.023-8.25c-.076-.365.183-.75.575-.75h.908c.889 0 1.713.518 1.972 1.368.339 1.11.521 2.287.521 3.507 0 1.553-.295 3.036-.831 4.398C20.613 14.547 19.833 15 19 15h-1.053c-.472 0-.745-.556-.5-.96a8.95 8.95 0 00.303-.54m.023-8.25H16.48a4.5 4.5 0 01-1.423-.23l-3.114-1.04a4.5 4.5 0 00-1.423-.23H6.504c-.618 0-1.217.247-1.605.729A11.95 11.95 0 002.25 12c0 .434.023.863.068 1.285C2.427 14.306 3.346 15 4.372 15h3.126c.618 0 .991.724.725 1.282A7.471 7.471 0 007.5 19.5a2.25 2.25 0 002.25 2.25.75.75 0 00.75-.75v-.633c0-.573.11-1.14.322-1.672.304-.76.93-1.33 1.653-1.715a9.04 9.04 0 002.86-2.4c.498-.634 1.226-1.08 2.032-1.08h.384" />
          </svg>
          {c.no}
        </button>
      </div>
    </div>
  );
}
