'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { collections, searchArticles } from './_content/articles';

const collectionIconPaths: Record<string, string> = {
  rocket:    'M15.59 14.37a6 6 0 01-5.84 7.38v-4.8m5.84-2.58a14.98 14.98 0 006.16-12.12A14.98 14.98 0 009.631 8.41m5.96 5.96a14.926 14.926 0 01-5.841 2.58m-.119-8.54a6 6 0 00-7.381 5.84h4.8m2.581-5.84a14.927 14.927 0 00-2.58 5.84m2.699 2.7c-.103.021-.207.041-.311.06a15.09 15.09 0 01-2.448-2.448 14.9 14.9 0 01.06-.312m-2.24 2.39a4.493 4.493 0 00-1.757 4.306 4.493 4.493 0 004.306-1.758M16.5 9a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0z',
  sliders:   'M10.5 6h9.75M10.5 6a1.5 1.5 0 11-3 0m3 0a1.5 1.5 0 10-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-9.75 0h9.75',
  phone:     'M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 002.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 01-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 00-1.091-.852H4.5A2.25 2.25 0 002.25 4.5v2.25z',
  chat:      'M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375m-13.5 3.01c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.184-4.183a1.14 1.14 0 01.778-.332 48.294 48.294 0 005.83-.498c1.585-.233 2.708-1.626 2.708-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z',
  card:      'M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 002.25-2.25V6.75A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25v10.5A2.25 2.25 0 004.5 19.5z',
  lifebuoy:  'M16.712 4.33a9.027 9.027 0 011.652 1.306c.51.51.944 1.064 1.306 1.652M16.712 4.33l-3.448 4.138m3.448-4.138a9.014 9.014 0 00-9.424 0M19.67 7.288l-4.138 3.448m4.138-3.448a9.014 9.014 0 010 9.424m-4.138-5.976a3.736 3.736 0 00-.88-1.388 3.737 3.737 0 00-1.388-.88m2.268 2.268a3.765 3.765 0 010 2.528m-2.268-4.796L9.83 9.832m4.138-2.456a3.765 3.765 0 00-2.528 0m-1.61 7.564l4.138-3.448m-4.138 3.448a9.014 9.014 0 01-9.424 0m4.138-3.448a3.765 3.765 0 002.528 0m-1.61-4.116L4.33 7.288m4.138 3.448a3.736 3.736 0 00-.88 1.388 3.737 3.737 0 00-.88 1.388M4.33 7.288a9.014 9.014 0 000 9.424',
};

export default function HelpHomePage() {
  const [query, setQuery] = useState('');

  const results = useMemo(() => searchArticles(query), [query]);
  const showingResults = query.trim().length >= 2;

  const totalArticles = collections.reduce((acc, c) => acc + c.articles.length, 0);

  return (
    <div className="-m-6 min-h-screen">
      {/* Hero with search */}
      <section className="relative isolate overflow-hidden bg-gradient-to-br from-brand-600 via-brand-700 to-brand-800 px-6 py-16 sm:py-20">
        <div className="absolute inset-0 -z-10">
          <div className="absolute -top-32 -left-32 h-96 w-96 rounded-full bg-brand-400/20 blur-3xl"></div>
          <div className="absolute -bottom-32 -right-32 h-96 w-96 rounded-full bg-fuchsia-500/15 blur-3xl"></div>
        </div>

        <div className="mx-auto max-w-4xl text-center text-white">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-100">Help centre</p>
          <h1 className="mt-3 text-4xl font-bold tracking-tight sm:text-5xl">How can we help?</h1>
          <p className="mx-auto mt-3 max-w-xl text-base text-brand-100">
            Guides for every feature in ReceptionMate. {totalArticles} articles across {collections.length} categories.
          </p>

          <div className="mx-auto mt-8 max-w-2xl">
            <div className="flex items-center gap-2 rounded-2xl border border-white/15 bg-white/95 p-2 shadow-2xl shadow-brand-900/30">
              <div className="flex flex-1 items-center pl-3">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 shrink-0 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search every guide — e.g. forwarding, WhatsApp, transfers"
                  className="ml-3 flex-1 bg-transparent py-2 text-base text-slate-900 placeholder:text-slate-400 focus:outline-none"
                  autoFocus
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Body */}
      <section className="mx-auto max-w-7xl px-6 py-12 sm:py-16">
        {showingResults ? (
          <div>
            <p className="text-sm text-slate-500">
              {results.length === 0
                ? `No matches for "${query}". Try a different phrase, or clear the search to browse.`
                : `${results.length} result${results.length === 1 ? '' : 's'} for "${query}"`}
            </p>
            <div className="mt-6 divide-y divide-slate-200 overflow-hidden rounded-2xl border border-slate-200 bg-white">
              {results.map(({ collection, article, matchedIn }) => (
                <Link
                  key={`${collection.slug}/${article.slug}`}
                  href={`/help/${collection.slug}/${article.slug}`}
                  className="flex items-center justify-between px-5 py-4 transition hover:bg-slate-50"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-base font-semibold text-slate-900">{article.title}</p>
                    <p className="mt-0.5 truncate text-sm text-slate-500">{article.excerpt}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-600">{collection.title}</span>
                      <span>{article.minutes} min read</span>
                      <span>· matched in {matchedIn}</span>
                    </div>
                  </div>
                  <svg xmlns="http://www.w3.org/2000/svg" className="ml-4 h-5 w-5 shrink-0 text-slate-300" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M3 10a.75.75 0 01.75-.75h10.638L10.23 5.29a.75.75 0 111.04-1.08l5.5 5.25a.75.75 0 010 1.08l-5.5 5.25a.75.75 0 11-1.04-1.08l4.158-3.96H3.75A.75.75 0 013 10z" clipRule="evenodd" /></svg>
                </Link>
              ))}
            </div>
            {results.length === 0 && (
              <button type="button" onClick={() => setQuery('')} className="mt-6 text-sm font-medium text-brand-600 hover:text-brand-700">
                Clear search
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {collections.map((c) => (
                <Link
                  key={c.slug}
                  href={`/help/${c.slug}`}
                  className="group rounded-2xl border border-slate-200 bg-white p-6 transition hover:border-brand-200 hover:shadow-lg hover:shadow-brand-900/5"
                >
                  <span className={`inline-flex h-12 w-12 items-center justify-center rounded-xl ${c.accent}`}>
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d={collectionIconPaths[c.icon]} />
                    </svg>
                  </span>
                  <h2 className="mt-4 text-lg font-semibold text-slate-900 transition-colors group-hover:text-brand-700">{c.title}</h2>
                  <p className="mt-1 text-sm text-slate-600">{c.description}</p>
                  <p className="mt-4 text-xs font-medium text-slate-400">{c.articles.length} article{c.articles.length === 1 ? '' : 's'}</p>
                </Link>
              ))}
            </div>

            {/* Popular guides */}
            <div className="mt-16 rounded-2xl border border-slate-200 bg-slate-50/50 p-8">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Popular guides</h2>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {[
                  { c: 'getting-started', a: 'forward-your-calls' },
                  { c: 'configuring-leah', a: 'faqs' },
                  { c: 'calls-and-bookings', a: 'reading-the-calls-page' },
                  { c: 'configuring-leah', a: 'integrations' },
                  { c: 'troubleshooting', a: 'agent-missed-booking' },
                  { c: 'billing-and-account', a: 'pricing-plans' },
                ].map(({ c, a }) => {
                  const collection = collections.find((col) => col.slug === c);
                  const article = collection?.articles.find((art) => art.slug === a);
                  if (!article || !collection) return null;
                  return (
                    <Link
                      key={`${c}/${a}`}
                      href={`/help/${c}/${a}`}
                      className="group flex items-center justify-between rounded-xl bg-white p-4 transition hover:shadow-md hover:shadow-brand-900/5"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-slate-900 group-hover:text-brand-700">{article.title}</p>
                        <p className="mt-0.5 truncate text-xs text-slate-500">{collection.title} · {article.minutes} min</p>
                      </div>
                      <svg xmlns="http://www.w3.org/2000/svg" className="ml-3 h-4 w-4 shrink-0 text-slate-300 group-hover:text-brand-600" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M3 10a.75.75 0 01.75-.75h10.638L10.23 5.29a.75.75 0 111.04-1.08l5.5 5.25a.75.75 0 010 1.08l-5.5 5.25a.75.75 0 11-1.04-1.08l4.158-3.96H3.75A.75.75 0 013 10z" clipRule="evenodd" /></svg>
                    </Link>
                  );
                })}
              </div>
            </div>

            {/* Contact */}
            <div className="mt-10 flex flex-col items-start justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-6 sm:flex-row sm:items-center">
              <div>
                <p className="text-base font-semibold text-slate-900">Still stuck?</p>
                <p className="mt-1 text-sm text-slate-600">Email our team and we'll usually reply within an hour.</p>
              </div>
              <a
                href="mailto:hello@receptionmate.co.uk"
                className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white shadow-md shadow-brand-600/25 hover:bg-brand-700 transition"
              >
                Email hello@receptionmate.co.uk
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M3 10a.75.75 0 01.75-.75h10.638L10.23 5.29a.75.75 0 111.04-1.08l5.5 5.25a.75.75 0 010 1.08l-5.5 5.25a.75.75 0 11-1.04-1.08l4.158-3.96H3.75A.75.75 0 013 10z" clipRule="evenodd" /></svg>
              </a>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
