// The HighLevel tag vocabulary: two prefixes, so a contact's row says where it came from and how
// far it got without anyone opening the record.
//
// WHY THIS EXISTS. Every entry point invented its own tags — 'website-lead' from the CTAs,
// 'website-signup'+'abandoned-checkout' from the funnel, 'blend-2026' from the show, nothing at
// all from the sales line (which therefore read as a website lead), and nothing from a demo call.
// Two contacts with the same tag could have arrived completely differently, and the pipeline stage
// only ever shows the furthest point reached: someone who enquired, tried the demo and then
// abandoned checkout looks identical to someone who only abandoned checkout.
//
//   from-*  WHERE the touch came from. More than one may accumulate: a garage that enquires on
//           the site and later rings the demo line genuinely came from both.
//   did-*   WHAT they did. These accumulate for the same reason, and they are the half that was
//           missing — "enquired, used the demo, or abandoned part way through signup" is now
//           three tags that can all be true at once, rather than one stage that can only be the
//           last of them.
//
// Tags are applied ADDITIVELY (see addContactTags in highlevel.ts). That is what makes the
// accumulation real; it also stops the directory-import tags ('mot centres', 'tmg-2026-10') being
// wiped off a contact the moment they touch the website.
//
// The legacy tags are still written alongside these. HL smart lists and workflows were built on
// them, and silently dropping them would break automations nobody would think to check.

/** Where a touch came from. */
export const FROM = {
  /** Any form on the marketing site. */
  website: 'from-website',
  /** A gclid came with it, so an ad can be credited. */
  googleAds: 'from-google-ads',
  /** Rang the shared demo number (+44 333 041 1784). */
  demoLine: 'from-demo-line',
  /** Clicked the browser demo on the site or the portal's /demo page. */
  webDemo: 'from-web-demo',
  /** Talked to a demo agent built as THEIR garage, off a personal /try/<slug> link. */
  ownDemo: 'from-own-demo',
  /** Phoned the 0333 front door and talked to the sales agent. */
  salesCall: 'from-sales-call',
  /** Emailed hello@ and the AI triage called it a sales enquiry. */
  helloEmail: 'from-hello-email',
  /** Came off a stand — the Blend funnel today. */
  tradeShow: 'from-trade-show',
} as const;

/** What they did. */
export const DID = {
  /** Asked us something: a form, an email, or a phone enquiry. */
  enquiry: 'did-enquiry',
  /** Actually talked to an agent and heard it work. */
  demo: 'did-demo',
  /** Rang a demo line and hung up before it got going — a real person, barely engaged. */
  demoDropped: 'did-demo-dropped',
  /** Picked their garage at the Places search step, so a signup was started. */
  signupStarted: 'did-signup-start',
  /** Gave their details and then never signed or paid. */
  abandonedCheckout: 'did-abandon-checkout',
  /** Reached a live trial account. */
  trial: 'did-trial',
} as const;

export type FromTag = (typeof FROM)[keyof typeof FROM];
export type DidTag = (typeof DID)[keyof typeof DID];

/**
 * Which `from-*` tag a website funnel touch deserves.
 *
 * Deliberately a prefix match on a source WE set, exactly as isBlendSource is in
 * public-prospect.ts and for the same reason: a show tag on an ordinary lead would overstate what
 * the stand produced, and nothing downstream would ever contradict it.
 */
export function websiteOriginTags(opts: { source?: string | null; fromAds?: boolean } = {}): string[] {
  const source = (opts.source ?? '').toLowerCase();
  const origin = source.startsWith('blend-') ? FROM.tradeShow : FROM.website;
  // An ad click is a second origin, not a replacement: a Blend lead that arrived via an ad is
  // both, and the ads tag is the key an offline conversion upload needs.
  return opts.fromAds ? [origin, FROM.googleAds] : [origin];
}

/** Merge tag lists, keeping the first occurrence of each and dropping blanks. */
export function mergeTags(...lists: Array<string[] | undefined>): string[] {
  const out: string[] = [];
  for (const list of lists) {
    for (const tag of list ?? []) {
      const t = tag.trim();
      if (t && !out.includes(t)) out.push(t);
    }
  }
  return out;
}
