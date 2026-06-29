# ReceptionMate marketing site

Astro + Tailwind. Static output, no runtime, mobile-first.

## Dev

```bash
cd marketing-site
npm install
npm run dev          # http://localhost:4321
```

## Build & preview

```bash
npm run build        # → dist/
npm run preview      # serve dist locally
```

## Deploy

`dist/` is plain HTML/CSS/JS — drop it on any static host:

- **Cloudflare Pages** — connect this repo, set build command `cd marketing-site && npm install && npm run build`, output dir `marketing-site/dist`
- **Vercel** — same, root `marketing-site`, framework Astro auto-detected
- **S3 + CloudFront** — `aws s3 sync dist/ s3://your-bucket/ --delete`

## Editing copy

Sections are individual `.astro` files in `src/components/`:

- `Hero.astro` — headline, CTA, live-call mockup
- `SocialProof.astro` — garage names (edit the `garages` array)
- `Problem.astro` — pain-point stats
- `Personas.astro` — Leah / Tom / Sophie cards
- `HowItWorks.astro` — 4-step onboarding walkthrough
- `Features.astro` — 6 feature cards
- `Testimonials.astro` — customer quotes (replace with real ones)
- `Signup.astro` — lead capture form

The site map is composed in `src/pages/index.astro`. The About page is `src/pages/about.astro`.

## Lead capture endpoint

`src/components/Hero.astro` has a `LEAD_ENDPOINT` constant at the top.
Currently set to `https://api.receptionmate.co.uk/api/leads` — **this endpoint doesn't exist yet**.

The submitted payload is `{ businessName, address, googlePlaceId, email }`.

Options to wire it up:

1. **Add `/api/leads` to portal-backend** — accept the payload, email hello@receptionmate.co.uk via the existing `sendEmail` util, return 200.
2. **Use Formspree / Web3Forms** — replace `LEAD_ENDPOINT` with their URL, no backend changes needed.
3. **Mailto fallback** — change the form's `onsubmit` to build a `mailto:` URL with the body prefilled.

## Google Places lookup (the "find your garage" search)

The hero search uses **Google Places Autocomplete**. Without a key it falls back to demo cards so you can preview the UX — set the key to enable real lookups.

1. Get an API key from https://console.cloud.google.com/google/maps-apis — enable **Places API** on your project.
2. **Restrict the key** by HTTP referrer to `www.receptionmate.co.uk/*` (and `localhost:4321/*` for dev) so it can't be stolen and used elsewhere.
3. Put it in `.env`:

   ```
   PUBLIC_GOOGLE_MAPS_API_KEY=AIza...
   ```

4. Restart `npm run dev`. The search will switch from demo mode to live Google results.

Google charges ~$2.83 per 1000 Place Autocomplete requests after the free tier. For a marketing site this typically stays inside the monthly free credit. Watch the billing dashboard.

## Branding

Defined in `tailwind.config.mjs`:

- Brand: indigo (`#6366f1`) → matches portal CTA colour
- Ink (background): slate-950 (`#0a0f1c`) — matches portal sidebar
- Type: Inter from rsms.me/inter

To rebrand for a sub-brand or A/B test, tweak the `brand` colour ramp and rebuild.

## What's intentionally NOT here yet

- Pricing page — add later when plans are finalised
- Self-serve onboarding — backend integration with Twilio + agent provisioning
- Blog / case studies
- OG image (`/og.png`) — add a 1200×630 social share image to `public/`
