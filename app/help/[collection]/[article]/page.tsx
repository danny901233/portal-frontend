import Link from 'next/link';
import { notFound } from 'next/navigation';
import { collections, getCollection, getArticle, type Block } from '../../_content/articles';
import HelpfulVote from './HelpfulVote';

export function generateStaticParams() {
  const params: { collection: string; article: string }[] = [];
  for (const collection of collections) {
    for (const article of collection.articles) {
      params.push({ collection: collection.slug, article: article.slug });
    }
  }
  return params;
}

type Props = { params: Promise<{ collection: string; article: string }> };

export default async function ArticlePage({ params }: Props) {
  const { collection: collectionSlug, article: articleSlug } = await params;
  const collection = getCollection(collectionSlug);
  const article = getArticle(collectionSlug, articleSlug);
  if (!collection || !article) notFound();

  const articleIndex = collection.articles.findIndex((a) => a.slug === article.slug);
  const prev = articleIndex > 0 ? collection.articles[articleIndex - 1] : null;
  const next = articleIndex < collection.articles.length - 1 ? collection.articles[articleIndex + 1] : null;

  return (
    <div className="-m-6 min-h-screen bg-white">
      {/* Top breadcrumb */}
      <div className="border-b border-slate-200 bg-slate-50/50 px-6 py-4">
        <div className="mx-auto max-w-6xl">
          <nav className="flex flex-wrap items-center gap-2 text-sm text-slate-500">
            <Link href="/help" className="hover:text-brand-700">Help centre</Link>
            <span className="text-slate-300">/</span>
            <Link href={`/help/${collection.slug}`} className="hover:text-brand-700">{collection.title}</Link>
            <span className="text-slate-300">/</span>
            <span className="text-slate-700">{article.title}</span>
          </nav>
        </div>
      </div>

      <div className="mx-auto max-w-6xl px-6 py-10">
        <div className="grid gap-10 lg:grid-cols-[1fr_260px]">
          {/* Article body */}
          <article>
            <header className="mb-8">
              <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${collection.accent}`}>{collection.title}</span>
              <h1 className="mt-3 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">{article.title}</h1>
              <p className="mt-2 text-base text-slate-600">{article.excerpt}</p>
              <p className="mt-3 text-xs font-medium text-slate-400">{article.minutes} min read</p>
            </header>

            <div className="prose-rm space-y-5 text-base leading-relaxed text-slate-700">
              {article.body.map((block, i) => (
                <BlockRenderer key={i} block={block} />
              ))}
            </div>

            <HelpfulVote articleKey={`${collection.slug}/${article.slug}`} />

            {/* Prev / next within this collection */}
            <nav className="mt-12 grid gap-3 border-t border-slate-200 pt-8 sm:grid-cols-2">
              {prev ? (
                <Link
                  href={`/help/${collection.slug}/${prev.slug}`}
                  className="group rounded-xl border border-slate-200 bg-white p-4 transition hover:border-brand-200 hover:shadow-sm sm:col-start-1"
                >
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Previous</p>
                  <p className="mt-1 text-sm font-semibold text-slate-900 group-hover:text-brand-700">← {prev.title}</p>
                </Link>
              ) : <div />}
              {next ? (
                <Link
                  href={`/help/${collection.slug}/${next.slug}`}
                  className="group rounded-xl border border-slate-200 bg-white p-4 text-right transition hover:border-brand-200 hover:shadow-sm sm:col-start-2"
                >
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Next</p>
                  <p className="mt-1 text-sm font-semibold text-slate-900 group-hover:text-brand-700">{next.title} →</p>
                </Link>
              ) : <div />}
            </nav>
          </article>

          {/* Sidebar — sibling articles in this collection */}
          <aside className="lg:sticky lg:top-6 lg:self-start">
            <div className="rounded-2xl border border-slate-200 bg-slate-50/50 p-5">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">In this collection</p>
              <ul className="mt-3 space-y-1">
                {collection.articles.map((a) => (
                  <li key={a.slug}>
                    <Link
                      href={`/help/${collection.slug}/${a.slug}`}
                      className={`block rounded-lg px-3 py-2 text-sm transition ${
                        a.slug === article.slug
                          ? 'bg-brand-600 text-white shadow-sm'
                          : 'text-slate-700 hover:bg-white hover:text-brand-700'
                      }`}
                    >
                      {a.title}
                    </Link>
                  </li>
                ))}
              </ul>
              <Link
                href={`/help/${collection.slug}`}
                className="mt-4 inline-block text-xs font-medium text-brand-600 hover:text-brand-700"
              >
                ← All in {collection.title}
              </Link>
            </div>

            <a
              href="mailto:hello@receptionmate.co.uk"
              className="mt-4 block rounded-2xl border border-slate-200 bg-white p-5 text-sm transition hover:border-brand-200 hover:shadow-sm"
            >
              <p className="font-semibold text-slate-900">Need a hand?</p>
              <p className="mt-1 text-slate-600">Email us at hello@receptionmate.co.uk and we'll reply within an hour.</p>
            </a>
          </aside>
        </div>
      </div>
    </div>
  );
}

function BlockRenderer({ block }: { block: Block }) {
  switch (block.type) {
    case 'p':
      return <p>{block.text}</p>;
    case 'h':
      return <h2 className="mt-8 text-xl font-semibold text-slate-900">{block.text}</h2>;
    case 'ul':
      return (
        <ul className="list-disc space-y-1.5 pl-6">
          {block.items.map((item, i) => <li key={i}>{item}</li>)}
        </ul>
      );
    case 'ol':
      return (
        <ol className="list-decimal space-y-1.5 pl-6">
          {block.items.map((item, i) => <li key={i}>{item}</li>)}
        </ol>
      );
    case 'code':
      return (
        <pre className="overflow-x-auto rounded-lg border border-slate-200 bg-slate-900 px-4 py-3 text-sm leading-relaxed text-emerald-200">
          <code>{block.text}</code>
        </pre>
      );
    case 'callout': {
      const styles = {
        tip:  { box: 'border-emerald-200 bg-emerald-50 text-emerald-900', label: 'Tip' },
        warn: { box: 'border-amber-200 bg-amber-50 text-amber-900',       label: 'Heads up' },
        info: { box: 'border-brand-200 bg-brand-50 text-brand-900',       label: 'Note' },
      } as const;
      const s = styles[block.tone];
      return (
        <div className={`rounded-xl border px-4 py-3 ${s.box}`}>
          <p className="text-xs font-semibold uppercase tracking-wide">{s.label}</p>
          <p className="mt-1 text-sm">{block.text}</p>
        </div>
      );
    }
  }
}
