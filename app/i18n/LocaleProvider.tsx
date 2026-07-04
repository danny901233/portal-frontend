'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { LOCALE_STORAGE_KEY, LOCALES, messages, type Locale } from './messages';

interface LocaleContextValue {
  locale: Locale;
  setLocale: (next: Locale) => void;
  /** Resolve a dot-path key, e.g. t('nav.dashboard'). Falls back to English, then the key itself. */
  t: (key: string) => string;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

function resolve(dict: unknown, key: string): string | undefined {
  return key.split('.').reduce<unknown>((acc, part) => {
    if (acc && typeof acc === 'object' && part in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[part];
    }
    return undefined;
  }, dict) as string | undefined;
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>('en');

  // Hydrate from storage after mount (avoids SSR/client mismatch — server always renders 'en').
  useEffect(() => {
    try {
      const saved = localStorage.getItem(LOCALE_STORAGE_KEY);
      if (saved && (LOCALES as string[]).includes(saved)) setLocaleState(saved as Locale);
    } catch {
      /* storage blocked — stay on 'en' */
    }
  }, []);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, next);
      // Cookie too, so a future server-side read can pick it up.
      document.cookie = `${LOCALE_STORAGE_KEY}=${next};path=/;max-age=31536000;samesite=lax`;
    } catch {
      /* ignore */
    }
    try {
      document.documentElement.lang = next;
    } catch {
      /* ignore */
    }
  }, []);

  const t = useCallback(
    (key: string) => resolve(messages[locale], key) ?? resolve(messages.en, key) ?? key,
    [locale],
  );

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error('useLocale must be used within LocaleProvider');
  return ctx;
}

/** Convenience: just the translate function. */
export function useT(): (key: string) => string {
  return useLocale().t;
}

/**
 * Current language ('en' | 'fr'). Use for self-contained per-component copy:
 *   const lang = useLang();
 *   const c = { en: { title: 'Calls' }, fr: { title: 'Appels' } }[lang];
 *   ...<h1>{c.title}</h1>
 * Parallel-safe (no shared dictionary file to edit). Client components only.
 */
export function useLang(): Locale {
  return useLocale().locale;
}
