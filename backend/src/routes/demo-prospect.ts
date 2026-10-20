// Builds a cold prospect their own AI receptionist, on demand, the first time they click the
// personal link in our email — so they hear "Good afternoon, Hilltop Motors, Leah speaking"
// rather than a generic demo.
//
// THE WHOLE TRICK, and why there is no Garage row anywhere in this file:
// the unified agent takes the id out of the LiveKit room name (`garage-<id>_web_<rand>`) and
// loads that id's runtime config from the `AgentConfig` DynamoDB table. It never asks Postgres.
// So a prospect's agent is just a DynamoDB item written under a synthetic id. 500 Garage rows
// would instead mean 500 fake customers in the garage pickers, dashboards, billing, the arrears
// sweep, the onboarding pipeline and the watchdog's routing audit — and "filter them out
// everywhere" is the version that leaks, as archived garages reappearing in the branch dropdown
// already proved once.
//
// Built lazily rather than up front: most prospects never click, and a lookup + site scrape per
// prospect is wasted on them. The few seconds it takes is also the best part of the page — a
// "building your receptionist…" screen is more persuasive than any copy we could write.

import type { Request, Response } from 'express';
import { Router } from 'express';
import { prisma } from '../db.js';
import {
  buildConfigurationResponse,
  defaultConfiguration,
  writeAgentConfigToDynamo,
} from './config.js';
import { industryDefaultFaqs, generateFaqsFromWebsite } from '../utils/faqGenerator.js';
import { fetchWebsiteInfo } from '../utils/scraper.js';
import { fetchPlaceDetails } from '../utils/googlePlaces.js';
import type { WeeklyOpeningHours } from '../utils/googlePlaces.js';

const router = Router();

// A garage that publishes no hours must still be OPEN, or the demo destroys itself: with every
// day closed, `opening_hours_text` tells the agent the garage is never open and the
// TRANSFER_HOURS_GATE blocks transfers around the clock. The prospect would ring their own
// receptionist and be told they are shut. This is the single most important line in the file.
const FALLBACK_HOURS: WeeklyOpeningHours = {
  monday: { open: '08:00', close: '17:30', closed: false },
  tuesday: { open: '08:00', close: '17:30', closed: false },
  wednesday: { open: '08:00', close: '17:30', closed: false },
  thursday: { open: '08:00', close: '17:30', closed: false },
  friday: { open: '08:00', close: '17:30', closed: false },
  saturday: { open: '08:30', close: '12:30', closed: false },
  sunday: { open: null, close: null, closed: true },
};

/**
 * Questions whose answer would be a claim about opening times. Used only when we have no
 * confirmed hours, to drop a generated FAQ rather than let the agent assert a guess.
 */
const ASKS_ABOUT_HOURS = /\b(open(ing)?|hours|close[ds]?|closing|what time|when are you|bank holiday)\b/i;

/**
 * Answers that narrate where they came from instead of answering.
 *
 * gpt-4o-mini is told to use only the supplied website content, and when the content is thin it
 * says so out loud: "The website content does not specify MOT services…", "the exact address is
 * not provided in the website content". Three of Binley Woods' eight FAQs read like that. A
 * receptionist describing our scrape of their own site is the most obvious possible tell that this
 * was generated, so those answers are dropped and the industry defaults — which answer MOTs,
 * payment and location perfectly well — are left to cover the question.
 */
const LEAKS_THE_SOURCE =
  /\b(website content|the content|not (specified?|provided|detailed|mentioned)|does not (specify|detail|mention|provide)|no information (is )?(available|provided)|based on the (website|content)|unclear from)\b/i;

/** True when at least one day is open. An all-closed week is never acceptable on a demo. */
const hasAnOpenDay = (hours: WeeklyOpeningHours | null | undefined): boolean =>
  !!hours && Object.values(hours).some((d) => d && !d.closed && d.open);

// Words a garage name is full of that must stay in capitals, because the TTS reads the letters
// rather than the word. "Smart Mot and Service Centre" is spoken "Smart Mott" — which is the
// prospect's own business name, mispronounced, in the opening three words of the demo.
const SPEAK_AS_LETTERS = new Set([
  'MOT', 'MOTS', 'HGV', 'LPG', 'DPF', 'ECU', 'PSV', 'LCV', 'TPMS', 'AC', 'EV',
  'BMW', 'VW', 'MG', 'JCB', 'RAC', 'AA', 'UK',
]);
// Lower-case in the middle of a name; "Underwoods Of Clacton" reads like a database row.
const SMALL_WORDS = new Set(['of', 'and', 'the', 'on', 'at', 'in', 'for', 'to', 'a']);

/** Case a business name the way it should be SPOKEN, not the way a CSV happens to store it. */
const titleCaseForSpeech = (input: string): string =>
  input
    .split(' ')
    .filter(Boolean)
    .map((word, i) => {
      const bare = word.replace(/[^A-Za-z0-9]/g, '');
      if (!bare) return word;
      if (SPEAK_AS_LETTERS.has(bare.toUpperCase())) return word.toUpperCase();
      // Initials — "J P Autotechnics", "G Crook and Sons".
      if (bare.length === 1) return word.toUpperCase();
      if (i > 0 && SMALL_WORDS.has(bare.toLowerCase())) return word.toLowerCase();
      // Capitalise the first LETTER, not the first character — a third of these names are
      // parenthesised ("racecourse garage (totnes) ltd") and `charAt(0)` is the bracket.
      return word.toLowerCase().replace(/[a-z]/, (ch) => ch.toUpperCase());
    })
    .join(' ');

/**
 * The scraped business name is lowercased and often keyword-stuffed — "hilltop mot & service
 * centre - tyres, brakes, camberley". The greeting is the first thing the prospect hears, so a
 * mangled name loses them in the opening three words. Kept deliberately conservative: it tidies
 * obvious junk and otherwise leaves the name alone.
 */
export const toSpokenName = (raw: string): string => {
  let s = (raw || '').trim();
  s = s.split(/\s+[-–]\s+|,/)[0];                       // drop trailing strap / town
  s = s.replace(/\s*\b(ltd|limited|llp|plc)\b\.?\s*$/i, '');
  s = s.replace(/&/g, ' and ').replace(/\s+/g, ' ').trim();
  return titleCaseForSpeech(s) || raw;
};

type KnowledgeDoc = { title: string; url: string; content: string };

/**
 * The garage's own website, as a knowledge document the agent can answer from.
 *
 * Without this the agent answers FAQ-shaped questions and nothing else. "Can you tell me a bit
 * about my garage" — the first thing a prospect asks, because hearing it know them IS the demo —
 * matches no FAQ and falls through to "I don't have any details about [garage] here myself", which
 * reads as the product knowing nothing at all. The FAQs alone are too narrow: 8 fixed questions
 * against keyword retrieval, so anything phrased loosely misses every one.
 *
 * Scraped hours are deliberately NOT included. weeklyOpeningHours is authoritative and is already
 * stated as fact; adding the website's hours text here would hand the agent a second, unvetted
 * version to read out — the exact failure the hours parser exists to prevent.
 */
const websiteKnowledge = async (
  websiteUrl: string,
  spokenName: string,
  /** Google's address, so the knowledge base can answer "where are you?" from the real one. */
  knownAddress: string,
): Promise<{ docs: KnowledgeDoc[]; publicEmail: string }> => {
  try {
    const info = await fetchWebsiteInfo(websiteUrl);

    // The garage's OWN published email, for the agent to offer if a caller asks. Taken from their
    // site rather than from our CRM contact record, which is often an owner's personal address
    // that has no business being read out to callers.
    const publicEmail = (info.emails || [])
      .map((e) => e.trim())
      .find((e) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(e) && !/receptionmate\.co\.uk$/i.test(e))
      ?? '';

    // Retrieval is plain token overlap against the title and content (search_knowledge in the
    // agent's portal_config.py), so a page only answers questions that reuse its own words.
    // "Where are you based?" scored zero against a page that says "located in the heart of Essex".
    // This lead sentence supplies the vocabulary callers actually use, in prose rather than a
    // keyword list, because the model may read it back.
    //
    // It names no opening times and no prices on purpose. Those would make this page a rival
    // source for the two questions that must only ever come from the verified fields.
    const lead =
      `${spokenName} is a car garage. This page covers who they are, the services and work they ` +
      `carry out, where they are based, their address and location, and how to contact them.`;

    // info.phoneNumbers is NOT included: on this very garage it extracted "30 - 18" out of an
    // hours line and a date alongside the real number, and a mangled number read aloud as fact is
    // worse than no number. The FAQ pass picks the real one up from the page correctly.
    const parts = [
      lead,
      info.title,
      info.description,
      // Google's address first, since it is the authoritative one; the page's own only if Google
      // had none.
      knownAddress ? `Address: ${knownAddress}` : (info.address && `Address: ${info.address}`),
      ...(info.knowledgeChunks || []).slice(0, 25),
    ].filter((p): p is string => typeof p === 'string' && p.trim().length > 0);

    const content = parts.join('\n').slice(0, 20000).trim();
    // Too thin to ground an answer. A title and a cookie banner is worse than admitting we do not
    // know, because the agent would answer confidently from almost nothing.
    if (content.replace(/\s/g, '').length < 120) return { docs: [], publicEmail };
    return { docs: [{ title: `About ${spokenName}`, url: websiteUrl, content }], publicEmail };
  } catch (err) {
    console.warn(`[DEMO_PROSPECT] knowledge scrape failed for ${spokenName}`, err);
    return { docs: [], publicEmail: '' };
  }
};

/**
 * "binley-woods-service-centre-3f9a2c7e4b1d8056" — their name plus 64 bits of CSPRNG.
 *
 * The suffix is the only access control on this endpoint, and a first POST spends a website scrape
 * and an OpenAI call, so it carries real weight. The seeder generates it (seed-demo-prospects.cjs).
 * 60-char name slice + '-' + 16 hex = 77, inside the 80 below and the same bound in livekit-demo.ts.
 */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// ── Guessing budget ───────────────────────────────────────────────────────────────────────────
// Unauthenticated, and the responses differ by whether a slug exists, so without a cap this is an
// oracle for enumerating the prospect list — and on a hit, a way to spend our scrape and OpenAI
// budget. A real prospect sends one GET and one POST, so twenty an hour is invisible to them.
//
// Keyed on cf-connecting-ip, NOT x-forwarded-for. Cloudflare sits in front of the portal and
// appends to XFF, so a client can prepend whatever it likes and read the first element — a limit
// keyed on XFF[0] is bypassed by one spoofed header per request. clientIp() in livekit-demo.ts
// still does exactly that; this does not copy it.
const LOOKUP_MAX = 20;
const LOOKUP_WINDOW_MS = 60 * 60 * 1000;
const lookupsByIp = new Map<string, { count: number; windowStart: number }>();

const clientIp = (req: Request): string => {
  const cf = String(req.headers['cf-connecting-ip'] || '').trim();
  if (cf) return cf;
  return req.socket?.remoteAddress || 'unknown';
};

/** Returns seconds to wait if the caller is over budget, else null. */
const overLookupBudget = (req: Request): number | null => {
  const now = Date.now();
  const key = clientIp(req);
  const b = lookupsByIp.get(key);
  if (!b || now - b.windowStart >= LOOKUP_WINDOW_MS) {
    lookupsByIp.set(key, { count: 1, windowStart: now });
    return null;
  }
  if (b.count >= LOOKUP_MAX) {
    return Math.max(1, Math.ceil((b.windowStart + LOOKUP_WINDOW_MS - now) / 1000));
  }
  b.count += 1;
  return null;
};

// Sweep so the map cannot grow without bound. unref() so it never holds the process open.
setInterval(() => {
  const cutoff = Date.now() - LOOKUP_WINDOW_MS;
  for (const [k, b] of lookupsByIp) if (b.windowStart < cutoff) lookupsByIp.delete(k);
}, LOOKUP_WINDOW_MS).unref();

router.post('/public/demo-prospect/:slug', async (req: Request, res: Response) => {
  const slug = String(req.params.slug || '').toLowerCase();
  if (!slug || slug.length < 6 || slug.length > 80 || !SLUG_RE.test(slug)) {
    return res.status(400).json({ error: 'bad_slug' });
  }

  // Before the lookup, so a guesser never reaches the database or the scrape.
  const wait = overLookupBudget(req);
  if (wait !== null) {
    res.setHeader('Retry-After', String(wait));
    return res.status(429).json({ error: 'rate_limited', retryAfter: wait });
  }

  const prospect = await prisma.demoProspect.findUnique({ where: { slug } });
  if (!prospect) {
    return res.status(404).json({ error: 'not_found' });
  }
  if (prospect.expiresAt.getTime() < Date.now()) {
    return res.status(410).json({ error: 'expired', message: 'This demo link has expired.' });
  }

  // Idempotent: a reload, a second tab or a phone call after a browser call must all land on the
  // same agent rather than rebuilding (and re-scraping) every time.
  if (prospect.builtAt) {
    return res.json({
      agentId: prospect.agentId,
      spokenName: prospect.spokenName,
      code: prospect.code,
      alreadyBuilt: true,
    });
  }

  const spokenName = prospect.spokenName || toSpokenName(prospect.businessName);
  const websiteUrl = prospect.websiteUrl ? `https://${prospect.websiteUrl.replace(/^https?:\/\//, '')}` : null;

  // Their real hours if resolve-demo-hours.ts found them on their own site, otherwise null.
  //
  // The distinction matters more than it looks. The fallback week still has to be permissive, or
  // `opening_hours_text` tells the agent the garage is never open and TRANSFER_HOURS_GATE blocks
  // transfers around the clock. But a permissive fallback must never be SPOKEN: Binley Woods
  // Service Centre's first build had its own receptionist saying "we are open Monday to Friday
  // from 08:00 to 17:30" when their site says 08:30. So an unknown-hours agent runs on the
  // fallback and is built not to state hours at all — vague is recoverable, wrong is not.
  const knownHours = (prospect.weeklyOpeningHours as WeeklyOpeningHours | null) ?? null;
  const hours = knownHours ?? FALLBACK_HOURS;

  // Their address and phone number, from Google, fetched once and cached on the row.
  //
  // The agent is handed "- address: …" in its prompt and had nothing to put there, so a prospect
  // asking where they were based got an offer to take a message — on a demo meant to prove the
  // thing knows them. Their website is not a fallback: the scrape found no address at all on
  // Protech's site, and the phone numbers it did find included "30 - 18" lifted from an hours
  // line. Google is the authority for both.
  let branchAddress = prospect.branchAddress ?? '';
  let phoneNumber = prospect.phoneNumber ?? '';
  if (prospect.placeId && !branchAddress) {
    try {
      const details = await fetchPlaceDetails(prospect.placeId);
      if (details?.address) branchAddress = details.address;
      if (details?.phone) phoneNumber = details.phone;
      if (branchAddress || phoneNumber) {
        // Cached so this is billed once per prospect rather than once per build, and so a wrong
        // address is reviewable in the table afterwards instead of only ever being heard.
        await prisma.demoProspect.update({
          where: { id: prospect.id },
          data: { branchAddress: branchAddress || null, phoneNumber: phoneNumber || null },
        });
        console.log(`[DEMO_PROSPECT] ${spokenName}: address/phone from Google`);
      }
    } catch (err) {
      // Never fatal: an agent with no address is worse than one with, but far better than none.
      console.warn(`[DEMO_PROSPECT] place lookup failed for ${spokenName}`, err);
    }
  }

  // Start from exactly the defaults a real garage gets and override only what makes this THEIR
  // agent. Building the object by hand is what silently dropped ten fields last time.
  const synthetic = {
    ...defaultConfiguration,
    branchName: spokenName,
    websiteUrl,
    branchAddress,
    phoneNumber,
    // NOT prospect.email. That is where our own post-call summary goes, and the agent reads this
    // field out as the garage's own address — so a test row pointed at us had the demo telling a
    // caller that Protech's email was dan@receptionmate.co.uk. Set below from their own website
    // if the scrape finds a real address there; otherwise the agent simply does not offer one.
    emailAddress: '',
    weeklyOpeningHours: hours,
    greetingLine: `[timeofday], ${spokenName}, Leah speaking, how can I help?`,
    // The fake diary: never fails, never invents a price, and an unpriced job becomes a
    // take-a-message lead rather than a dead end.
    integrationProvider: 'demo',
    agentScript: 'unified-agent',
    agentType: 'automate',
    allowBookings: true,
    bookingLeadTimeDays: 1,
    voice: 'leah',
    // There is nobody to transfer a demo caller to, and an escalation that rings nothing is a
    // worse demo than no escalation at all.
    humanEscalation: false,
    transferNumber: '',
    screenBeforeAgent: false,
    shortCallCallback: false,
    notificationEmails: [],
    faqs: industryDefaultFaqs(spokenName),
  } as unknown as Parameters<typeof buildConfigurationResponse>[0];

  const configuration = buildConfigurationResponse(synthetic);

  // Writing straight to DynamoDB skips the zod validator that guards the portal's save path, so
  // the assertions it would have made have to be made here instead. A malformed config does not
  // throw — it produces an agent with no booking tools and no error anywhere.
  const cfg = configuration as unknown as Record<string, unknown>;
  const problems: string[] = [];
  if (cfg.integrationProvider !== 'demo') problems.push(`integrationProvider collapsed to "${String(cfg.integrationProvider)}"`);
  if (cfg.agentScript !== 'unified-agent') problems.push(`agentScript is "${String(cfg.agentScript)}"`);
  if (!cfg.branchName) problems.push('branchName empty — the agent would greet with no garage name');
  if (!hasAnOpenDay(cfg.weeklyOpeningHours as WeeklyOpeningHours)) problems.push('every day closed — the agent would tell them they are shut');
  if (!Array.isArray(cfg.faqs) || (cfg.faqs as unknown[]).length === 0) problems.push('faqs empty');
  if (problems.length) {
    console.error(`[DEMO_PROSPECT] refusing to publish a broken config for ${prospect.businessName}:`, problems);
    return res.status(500).json({ error: 'config_invalid', problems });
  }

  await writeAgentConfigToDynamo(prospect.agentId, configuration, [], null);

  await prisma.demoProspect.update({
    where: { id: prospect.id },
    data: { builtAt: new Date(), spokenName },
  });

  console.log(`[DEMO_PROSPECT] built ${spokenName} (agent ${prospect.agentId}) for ${prospect.email ?? 'no email'}`);

  // Their own website in the knowledge base is what makes the demo sound like their garage
  // rather than a generic one — but it takes several seconds, so it lands after the page is
  // already usable. The call picks up whichever version of the config is current when it starts.
  if (websiteUrl) {
    void (async () => {
      try {
        // The knowledge base first, and written on its own as soon as it is ready: it is what lets
        // the agent talk about the garage at all, and it must not be lost if the FAQ generation
        // below fails or OpenAI is down.
        const { docs: knowledge, publicEmail } = await websiteKnowledge(websiteUrl, spokenName, branchAddress);
        const knowledgeVersion = knowledge.length ? new Date().toISOString() : null;

        // Their own published email, now that we have scraped it. Rebuilt through
        // buildConfigurationResponse rather than patched onto the response object, so it goes
        // through the same shaping as every other field.
        const withEmail = publicEmail
          ? buildConfigurationResponse({
              ...(synthetic as unknown as Record<string, unknown>),
              emailAddress: publicEmail,
            } as unknown as Parameters<typeof buildConfigurationResponse>[0])
          : configuration;

        if (knowledge.length || publicEmail) {
          await writeAgentConfigToDynamo(prospect.agentId, withEmail, knowledge, knowledgeVersion);
          console.log(`[DEMO_PROSPECT] ${spokenName}: knowledge base ${knowledge.length ? `${knowledge[0].content.length} chars` : 'none'}${publicEmail ? `, email ${publicEmail}` : ''}`);
        }

        // knownHours, not the fallback. Handing the generator invented hours is precisely what
        // produced an FAQ stating the wrong opening time as fact.
        const generated = await generateFaqsFromWebsite(websiteUrl, spokenName, knownHours);
        // With no confirmed hours, drop anything the model wrote about opening times. The
        // industry default already covers the question safely ("the team will confirm exact times
        // when you call"), so dropping the generated one leaves a true answer rather than no
        // answer.
        const faqs = generated
          .filter((f) => knownHours || !ASKS_ABOUT_HOURS.test(f.question))
          .filter((f) => !LEAKS_THE_SOURCE.test(f.answer));
        if (!Array.isArray(faqs) || faqs.length === 0) return;
        if (faqs.length < generated.length) {
          console.log(`[DEMO_PROSPECT] ${spokenName}: dropped ${generated.length - faqs.length} unusable FAQ(s)`);
        }
        const enriched = buildConfigurationResponse({
          ...(synthetic as unknown as Record<string, unknown>),
          // emailAddress carried through for the same reason as `knowledge` below: this write
          // replaces the whole item, so rebuilding from `synthetic` alone would blank it again.
          ...(publicEmail ? { emailAddress: publicEmail } : {}),
          faqs,
        } as unknown as Parameters<typeof buildConfigurationResponse>[0]);
        // Carries `knowledge` through deliberately: this write replaces the whole item, so passing
        // [] here would silently wipe the knowledge base written moments earlier.
        await writeAgentConfigToDynamo(prospect.agentId, enriched, knowledge, knowledgeVersion);
        console.log(`[DEMO_PROSPECT] ${spokenName}: ${faqs.length} FAQ(s) from ${websiteUrl}`);
      } catch (err) {
        console.error(`[DEMO_PROSPECT] website FAQ pass failed for ${spokenName}`, err);
      }
    })();
  }

  return res.json({ agentId: prospect.agentId, spokenName, code: prospect.code, alreadyBuilt: false });
});

/** Read-only: what the page needs to render before anyone presses anything. */
router.get('/public/demo-prospect/:slug', async (req: Request, res: Response) => {
  const slug = String(req.params.slug || '').toLowerCase();
  if (slug.length < 6 || slug.length > 80 || !SLUG_RE.test(slug)) {
    return res.status(400).json({ error: 'bad_slug' });
  }
  const wait = overLookupBudget(req);
  if (wait !== null) {
    res.setHeader('Retry-After', String(wait));
    return res.status(429).json({ error: 'rate_limited', retryAfter: wait });
  }
  const prospect = await prisma.demoProspect.findUnique({ where: { slug } });
  if (!prospect) return res.status(404).json({ error: 'not_found' });
  if (prospect.expiresAt.getTime() < Date.now()) return res.status(410).json({ error: 'expired' });
  return res.json({
    spokenName: prospect.spokenName || toSpokenName(prospect.businessName),
    code: prospect.code,
    built: Boolean(prospect.builtAt),
  });
});

export default router;
