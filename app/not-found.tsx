import Link from 'next/link';
import { cookies } from 'next/headers';
import { LOCALE_STORAGE_KEY } from './i18n/messages';

export default async function NotFound() {
  const lang = (await cookies()).get(LOCALE_STORAGE_KEY)?.value === 'fr' ? 'fr' : 'en';
  const c = {
    en: {
      title: 'Not Found',
      body: 'The page you are looking for could not be located. Double-check the URL or return to the calls dashboard.',
      back: 'Back to Calls',
    },
    fr: {
      title: 'Page introuvable',
      body: "La page que vous recherchez est introuvable. Vérifiez l’URL ou revenez au tableau de bord des appels.",
      back: 'Retour aux appels',
    },
  }[lang];
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center space-y-3 text-center text-slate-600">
      <h1 className="text-3xl font-semibold text-slate-900">{c.title}</h1>
      <p className="max-w-md text-sm">{c.body}</p>
      <Link
        href="/calls"
        className="rounded-md border border-slate-300 px-3 py-1 text-xs font-medium text-slate-900 transition-colors hover:border-slate-500 hover:text-slate-900"
      >
        {c.back}
      </Link>
    </div>
  );
}
