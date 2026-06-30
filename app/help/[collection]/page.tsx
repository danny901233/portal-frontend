import Link from 'next/link';
import { notFound } from 'next/navigation';
import { collections, getCollection } from '../_content/articles';

export function generateStaticParams() {
  return collections.map((c) => ({ collection: c.slug }));
}

type Props = { params: Promise<{ collection: string }> };

export default async function CollectionPage({ params }: Props) {
  const { collection: collectionSlug } = await params;
  const collection = getCollection(collectionSlug);
  if (!collection) notFound();

  return (
    <div className="-m-6 min-h-screen bg-white">
      {/* Breadcrumb / header */}
      <div className="border-b border-slate-200 bg-slate-50/50 px-6 py-8">
        <div className="mx-auto max-w-5xl">
          <nav className="flex items-center gap-2 text-sm text-slate-500">
            <Link href="/help" className="hover:text-brand-700">Help centre</Link>
            <span className="text-slate-300">/</span>
            <span className="text-slate-700">{collection.title}</span>
          </nav>
          <div className="mt-4 flex items-start gap-4">
            <span className={`inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-xl ${collection.accent}`}>
              <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
              </svg>
            </span>
            <div>
              <h1 className="text-3xl font-bold tracking-tight text-slate-900">{collection.title}</h1>
              <p className="mt-1 text-base text-slate-600">{collection.description}</p>
              <p className="mt-2 text-xs font-medium text-slate-400">{collection.articles.length} article{collection.articles.length === 1 ? '' : 's'}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Article list */}
      <div className="px-6 py-10">
        <div className="mx-auto max-w-5xl">
          <ol className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
            {collection.articles.map((article, idx) => (
              <li key={article.slug} className={idx > 0 ? 'border-t border-slate-200' : ''}>
                <Link
                  href={`/help/${collection.slug}/${article.slug}`}
                  className="group flex items-start gap-4 px-6 py-5 transition hover:bg-slate-50"
                >
                  <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-slate-100 font-mono text-xs font-semibold text-slate-600 transition group-hover:bg-brand-100 group-hover:text-brand-700">
                    {String(idx + 1).padStart(2, '0')}
                  </span>
                  <div className="min-w-0 flex-1">
                    <h2 className="text-base font-semibold text-slate-900 group-hover:text-brand-700">{article.title}</h2>
                    <p className="mt-1 text-sm text-slate-600">{article.excerpt}</p>
                    <p className="mt-2 text-xs text-slate-400">{article.minutes} min read</p>
                  </div>
                  <svg xmlns="http://www.w3.org/2000/svg" className="mt-1 h-5 w-5 shrink-0 text-slate-300 transition group-hover:text-brand-600" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M3 10a.75.75 0 01.75-.75h10.638L10.23 5.29a.75.75 0 111.04-1.08l5.5 5.25a.75.75 0 010 1.08l-5.5 5.25a.75.75 0 11-1.04-1.08l4.158-3.96H3.75A.75.75 0 013 10z" clipRule="evenodd" /></svg>
                </Link>
              </li>
            ))}
          </ol>

          <p className="mt-8 text-center text-sm text-slate-500">
            Can't find what you need?{' '}
            <a href="mailto:hello@receptionmate.co.uk" className="font-medium text-brand-600 hover:text-brand-700">Email our team</a>
          </p>
        </div>
      </div>
    </div>
  );
}
