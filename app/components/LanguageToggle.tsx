'use client';

import { useLocale } from '../i18n/LocaleProvider';

/** EN | FR pill toggle. Switches locale instantly (no reload) via LocaleProvider. */
export default function LanguageToggle({ className = '' }: { className?: string }) {
  const { locale, setLocale } = useLocale();
  return (
    <div
      className={`inline-flex items-center rounded-full border border-slate-200 bg-white p-0.5 text-[11px] font-semibold ${className}`}
      role="group"
      aria-label="Language"
    >
      <button
        type="button"
        onClick={() => setLocale('en')}
        aria-pressed={locale === 'en'}
        className={`rounded-full px-2 py-0.5 transition ${
          locale === 'en' ? 'bg-brand-600 text-white' : 'text-slate-500 hover:text-slate-900'
        }`}
      >
        EN
      </button>
      <button
        type="button"
        onClick={() => setLocale('fr')}
        aria-pressed={locale === 'fr'}
        className={`rounded-full px-2 py-0.5 transition ${
          locale === 'fr' ? 'bg-brand-600 text-white' : 'text-slate-500 hover:text-slate-900'
        }`}
      >
        FR
      </button>
    </div>
  );
}
