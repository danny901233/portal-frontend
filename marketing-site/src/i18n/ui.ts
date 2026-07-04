// Lightweight i18n helpers for the marketing site.
//
// English is served at the root (/), French under /fr/. Every component/page
// derives its language from the URL via getLang(Astro.url) (or Astro.currentLocale)
// and pulls copy from an inline { en, fr } object. Shared shell copy (nav,
// footer, CTAs) lives in the `ui` dictionary below.

export type Lang = 'en' | 'fr';
export const defaultLang: Lang = 'en';
export const languages: Record<Lang, string> = { en: 'EN', fr: 'FR' };

/** Language from a URL — 'fr' when the path starts with /fr, else 'en'. */
export function getLang(url: URL): Lang {
  const seg = url.pathname.split('/')[1];
  return seg === 'fr' ? 'fr' : 'en';
}

/** Prefix an internal path for the active locale. L('/pricing','fr') -> '/fr/pricing'. */
export function L(path: string, lang: Lang): string {
  if (lang !== 'fr') return path;
  if (path === '/') return '/fr/';
  return path.startsWith('/') ? `/fr${path}` : `/fr/${path}`;
}

/** Same path in the other locale — used by the language toggle. */
export function altLangHref(url: URL, target: Lang): string {
  const stripped = url.pathname.replace(/^\/fr(?=\/|$)/, '') || '/';
  return target === 'fr' ? (stripped === '/' ? '/fr/' : `/fr${stripped}`) : stripped;
}

export const ui = {
  en: {
    nav: {
      how: 'How it works',
      pricing: 'Pricing',
      caseStudies: 'Case studies',
      connect: 'Connect — WhatsApp + Web chat',
      integrations: 'Integrations',
      blog: 'Blog',
      faqs: 'FAQs',
      about: 'Why ReceptionMate',
      signin: 'Sign in',
      login: 'Login',
      getStarted: 'Get started',
      home: 'ReceptionMate home',
      openMenu: 'Open menu',
      skip: 'Skip to content',
    },
    footer: {
      tagline: 'AI receptionist for UK garages. Answer every call, book every job — automatically.',
      product: 'Product',
      company: 'Company',
      about: 'About',
      contact: 'Contact',
      privacy: 'Privacy',
      whyUs: 'Why us',
      gdpr: 'UK GDPR compliant',
      company_no: 'Company No. 16839506',
      tls: 'TLS encrypted',
      rights: 'All rights reserved.',
      registered: "Registered in England & Wales · Studio 9, 50–54 St. Paul's Square, Birmingham B3 1QS",
    },
    cookie: {
      text: "We use essential cookies to make this site work. With your permission we'd also use a few non-essential cookies (e.g. analytics) to understand which pages are useful. See our",
      privacy: 'privacy policy',
      decline: 'Decline non-essential',
      accept: 'Accept all',
      label: 'Cookie consent',
    },
  },
  fr: {
    nav: {
      how: 'Comment ça marche',
      pricing: 'Tarifs',
      caseStudies: 'Études de cas',
      connect: 'Connect — WhatsApp + Chat web',
      integrations: 'Intégrations',
      blog: 'Blog',
      faqs: 'FAQ',
      about: 'Pourquoi ReceptionMate',
      signin: 'Se connecter',
      login: 'Connexion',
      getStarted: 'Commencer',
      home: 'Accueil ReceptionMate',
      openMenu: 'Ouvrir le menu',
      skip: 'Aller au contenu',
    },
    footer: {
      tagline: 'Réceptionniste IA pour les garages. Répondez à chaque appel, réservez chaque intervention — automatiquement.',
      product: 'Produit',
      company: 'Entreprise',
      about: 'À propos',
      contact: 'Contact',
      privacy: 'Confidentialité',
      whyUs: 'Pourquoi nous',
      gdpr: 'Conforme au RGPD',
      company_no: 'N° de société 16839506',
      tls: 'Chiffrement TLS',
      rights: 'Tous droits réservés.',
      registered: "Enregistrée en Angleterre et au Pays de Galles · Studio 9, 50–54 St. Paul's Square, Birmingham B3 1QS",
    },
    cookie: {
      text: 'Nous utilisons des cookies essentiels au fonctionnement du site. Avec votre accord, nous utiliserions aussi quelques cookies non essentiels (par ex. analytiques) pour comprendre quelles pages sont utiles. Consultez notre',
      privacy: 'politique de confidentialité',
      decline: 'Refuser les non essentiels',
      accept: 'Tout accepter',
      label: 'Consentement aux cookies',
    },
  },
} as const;

/** Shared shell copy for a language. */
export function t(lang: Lang) {
  return ui[lang] ?? ui.en;
}
