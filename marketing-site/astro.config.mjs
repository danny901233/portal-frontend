import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://www.receptionmate.co.uk',
  // English stays at the root (/), French is served under /fr/. Components and
  // pages read Astro.currentLocale (derived from this) to pick their copy.
  i18n: {
    locales: ['en', 'fr'],
    defaultLocale: 'en',
    routing: { prefixDefaultLocale: false },
  },
  integrations: [
    sitemap({
      // Pages that set noindex must not also be advertised in the sitemap — it asks Google to
      // crawl something we then tell it to drop. /blend is the Blend show offer: time-limited,
      // reached by QR, and not something that should outlive the offer in search results.
      filter: (page) => !/\/blend\/?$/.test(new URL(page).pathname),
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});
