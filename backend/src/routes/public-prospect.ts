// Progressive-capture prospect endpoints for the marketing get-started funnel.
//   POST  /public/prospect       — step 1 (garage chosen): create a PendingSignup + a
//                                   HighLevel opportunity in "Abandoned checkout".
//   PATCH /public/prospect/:id    — step 2 (contact details): enrich the contact + prospect.
//   GET   /public/places-autocomplete — garage type-ahead for step 1, proxied server-side.
// No account is created here — that only happens after sign + card (see webhooks/stripe.ts).

import type { Request, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { prisma } from '../db.js';
import { fetchPlaceDetails, placesAutocomplete } from '../utils/googlePlaces.js';
import { highlevelConfigured, upsertContact, updateContact, createOpportunity } from '../services/highlevel.js';
import type { Prisma } from '@prisma/client';

const router = Router();

const SIGN_LINK_TTL_MS = 14 * 24 * 60 * 60 * 1000;

const createSchema = z.object({
  businessName: z.string().trim().min(2).max(200),
  googlePlaceId: z.string().trim().max(200).optional(),
  address: z.string().trim().max(500).optional(),
  // Which landing page this came from. /mot was already sending it and this schema silently
  // dropped it, so no signup could be attributed to a page.
  source: z.string().trim().max(100).optional(),
  // The Google Ads click id. It was only ever sent at the later signup steps, so a prospect who
  // stopped at step 1 — which is most of them, and the whole point of the abandoned stage —
  // could never be traced back to the ad that produced them.
  gclid: z.string().trim().max(200).optional(),
});

const enrichSchema = z.object({
  name: z.string().trim().max(120).optional(),
  email: z.string().trim().email().max(254).optional(),
  phone: z.string().trim().max(40).optional(),
  gclid: z.string().trim().max(200).optional(),
  product: z.enum(['assist', 'automate', 'connect', 'multibranch', 'custom']).optional(),
});

// Give the opportunity a helpful name as we learn more about the prospect.
function oppName(businessName: string, product?: string | null, source?: string | null): string {
  const suffix = isBlendSource(source) ? ' (Blend)' : '';
  if (!product) return `${businessName} — signup started${suffix}`;
  const label = product === 'assist' ? 'Assist' : product === 'automate' ? 'Automate'
    : product === 'connect' ? 'Connect' : product === 'multibranch' ? 'Multi-branch' : 'Custom';
  return `${businessName} — ${label}${suffix}`;
}

/**
 * Did this prospect come off the Blend show funnel?
 *
 * The campaign tag has to be decided HERE, at the garage-search step, because that is the only
 * moment every QR scan passes through — most never reach the offer, let alone sign up, and those
 * are exactly the ones worth knowing came from the stand.
 *
 * Deliberately a prefix match on a source WE set, not a guess at intent: /blend posts
 * 'blend-show' and the ordinary funnels post 'website-getstarted' and 'website-mot-campaign',
 * which cannot begin with "blend-". A signup that did not come through the show therefore cannot
 * acquire the tag, which is the half of this that actually matters — a Blend tag on an ordinary
 * lead would quietly overstate what the stand produced.
 */
export function isBlendSource(source?: string | null): boolean {
  return typeof source === 'string' && source.startsWith('blend-');
}

/** Campaign tags for a prospect, on top of the ones every website lead gets. */
export function tagsForSource(source?: string | null): string[] {
  const base = ['website-signup', 'abandoned-checkout'];
  return isBlendSource(source) ? [...base, 'blend-2026'] : base;
}

// Sync a prospect to HighLevel: always upsert (enrich) the contact; create the abandoned-
// checkout opportunity ONLY if one doesn't exist yet (idempotent — safe to call at every step).
// Best-effort; returns the resolved { opportunityId, contactId }.
async function syncProspectToHl(pending: {
  id: string; businessName: string; name: string | null; email: string | null;
  phoneNumber: string | null; contactPhone: string | null; websiteUrl: string | null; product: string | null;
  ghlOpportunityId: string | null; ghlContactId: string | null; source?: string | null;
}): Promise<{ opportunityId: string | null; contactId: string | null }> {
  if (!highlevelConfigured()) {
    return { opportunityId: pending.ghlOpportunityId, contactId: pending.ghlContactId };
  }

  const realPhone = pending.contactPhone || pending.phoneNumber || undefined;
  const realEmail = pending.email || undefined;
  let contactId = pending.ghlContactId;

  if (contactId) {
    // Enrich the EXISTING contact by id (replaces any placeholder) — never creates a duplicate.
    await updateContact(contactId, {
      name: pending.name || pending.businessName,
      email: realEmail,
      phone: realPhone,
      website: pending.websiteUrl ?? undefined,
    });
  } else {
    // First contact for this prospect. HL needs a phone OR email; if we have neither yet (no
    // Google phone, no email until the next step), use a UNIQUE placeholder email so the
    // opportunity is still created from just the business name. It's overwritten on enrich.
    const placeholderEmail = !realEmail && !realPhone ? `prospect-${pending.id}@pending.receptionmate.co.uk` : undefined;
    const contact = await upsertContact({
      name: pending.name || pending.businessName,
      email: realEmail || placeholderEmail,
      phone: realPhone,
      companyName: pending.businessName,
      website: pending.websiteUrl ?? undefined,
      source: pending.source || 'website-getstarted',
      tags: tagsForSource(pending.source),
    });
    contactId = contact.contactId;
  }

  let opportunityId = pending.ghlOpportunityId;
  if (!opportunityId && contactId) {
    const opp = await createOpportunity({
      contactId,
      name: oppName(pending.businessName, pending.product, pending.source),
      kind: 'abandoned',
    });
    opportunityId = opp.id;
  }
  return { opportunityId, contactId };
}

// POST /api/public/prospect — step 1
router.post('/public/prospect', async (req: Request, res: Response) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'invalid_request' });
  const { businessName, googlePlaceId, address, source, gclid } = parsed.data;

  try {
    const place = googlePlaceId ? await fetchPlaceDetails(googlePlaceId) : null;
    const signToken = randomBytes(32).toString('base64url');
    const pending = await prisma.pendingSignup.create({
      data: {
        businessName,
        email: '', // filled at the enrich step
        googlePlaceId: googlePlaceId ?? null,
        branchAddress: place?.address || address || null,
        phoneNumber: place?.phone || null,
        websiteUrl: place?.website || null,
        weeklyOpeningHours: place?.weeklyOpeningHours
          ? (place.weeklyOpeningHours as Prisma.InputJsonValue)
          : undefined,
        signToken,
        status: 'prospect',
        // The only record of which page produced this signup: a cross-origin POST sends just the
        // origin as Referer, so the path never reaches us.
        source: source ?? null,
        gclid: gclid ?? null,
        expiresAt: new Date(Date.now() + SIGN_LINK_TTL_MS),
      },
    });

    // Fire the abandoned-checkout opportunity (best-effort; won't block the response).
    void syncProspectToHl(pending)
      .then(({ opportunityId, contactId }) => {
        if (opportunityId || contactId) {
          return prisma.pendingSignup.update({
            where: { id: pending.id },
            data: { ghlOpportunityId: opportunityId, ghlContactId: contactId },
          });
        }
      })
      .catch((e) => console.error('[PROSPECT] HL abandoned opp failed:', e));

    return res.json({ ok: true, prospectId: pending.id, signToken });
  } catch (err) {
    console.error('[PROSPECT] create failed:', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// PATCH /api/public/prospect/:id — step 2 (enrich with contact details)
router.patch('/public/prospect/:id', async (req: Request, res: Response) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const parsed = enrichSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'invalid_request' });

  try {
    const pending = await prisma.pendingSignup.findUnique({ where: { id: req.params.id } });
    if (!pending || pending.status === 'completed') {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    const updated = await prisma.pendingSignup.update({
      where: { id: pending.id },
      data: {
        name: parsed.data.name ?? pending.name,
        email: parsed.data.email ? parsed.data.email.toLowerCase() : pending.email,
        contactPhone: parsed.data.phone ?? pending.contactPhone,
        product: parsed.data.product ?? pending.product,
        // Keep the earliest click id — the first touch is the one that won the click.
        gclid: pending.gclid || parsed.data.gclid || null,
      },
    });

    // Enrich the HL contact + create the opp now if it wasn't made at step 1 (no id then).
    void syncProspectToHl(updated)
      .then(({ opportunityId, contactId }) => {
        if (opportunityId !== updated.ghlOpportunityId || contactId !== updated.ghlContactId) {
          return prisma.pendingSignup.update({
            where: { id: updated.id },
            data: { ghlOpportunityId: opportunityId, ghlContactId: contactId },
          });
        }
      })
      .catch((e) => console.error('[PROSPECT] HL enrich failed:', e));

    return res.json({ ok: true });
  } catch (err) {
    console.error('[PROSPECT] enrich failed:', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ---------------------------------------------------------------------------
// Garage type-ahead for step 1 of the get-started funnel.
//
// The marketing site used to load Google Maps JS in the browser with its own
// PUBLIC_GOOGLE_MAPS_API_KEY. That key lived in a Cloud project whose billing was
// disabled, so every autocomplete came back 403 PERMISSION_DENIED and the search box
// silently did nothing. Swapping in this backend's key wasn't an option either: a key
// pasted into public HTML has to be referrer-locked, and GOOGLE_PLACES_API_KEY is
// called server-side with no referrer (signup auto-populate), so locking it would
// break that. Proxying is the way out — the public site ships no Maps key at all.
//
// Deliberately unauthenticated (it sits under the open /api/public/* CORS block), so
// it is throttled per IP and never echoes Google's errors back to the caller.
// ---------------------------------------------------------------------------

type AcBucket = { count: number; windowStart: number; last: number };
const acByIp = new Map<string, AcBucket>();
const AC_WINDOW = 60 * 1000;
const AC_IP_MAX = 60;
// Global ceiling across every caller. The per-IP bucket is keyed on a header, and any
// header can be spoofed by someone who reaches the origin directly, so this is the only
// limit that actually bounds the Google bill. Sized well above real funnel traffic.
const AC_GLOBAL_MAX = 200;
let acGlobal: AcBucket = { count: 0, windowStart: 0, last: 0 };

// Sweep hourly so the map can't grow without bound. unref() so it never holds the process open.
setInterval(() => {
  const cutoff = Date.now() - AC_WINDOW;
  for (const [k, b] of acByIp) if (b.last < cutoff) acByIp.delete(k);
}, 60 * 60 * 1000).unref();

/**
 * Best available client IP for throttling.
 *
 * `trust proxy` is off, so req.ip is the loopback. x-forwarded-for can't be read from the
 * left either: Cloudflare fronts this origin and APPENDS the real peer to whatever the
 * caller sent, and nginx (`$proxy_add_x_forwarded_for`) then appends the Cloudflare edge —
 * so the chain is [caller-supplied..., real client, cf edge] and chain[0] is whatever the
 * caller typed. Reading chain[0] made the limit a no-op: 100 requests with a rotating
 * header all returned 200 where 60 unspoofed had already started 429ing.
 *
 * cf-connecting-ip is the one trustworthy source — Cloudflare rejects a request that tries
 * to set it itself (verified: 403 at the edge). Fall back to the last x-forwarded-for entry,
 * which nginx wrote from the real peer, for anything arriving at the origin directly.
 */
function acClientIp(req: Request): string {
  const cf = (req.headers['cf-connecting-ip'] as string | undefined)?.trim();
  if (cf) return cf;
  const chain = (req.headers['x-forwarded-for'] as string | undefined)?.split(',') ?? [];
  return chain[chain.length - 1]?.trim() || req.ip || 'unknown';
}

function bump(b: AcBucket, max: number, now: number): boolean {
  if (now - b.windowStart >= AC_WINDOW) { b.count = 1; b.windowStart = now; b.last = now; return false; }
  b.last = now;
  if (b.count >= max) return true;
  b.count += 1;
  return false;
}

function acThrottled(ip: string): boolean {
  const now = Date.now();
  // Check the global ceiling first, and don't let a throttled caller consume the global
  // budget: a spoofing client would otherwise still spend everyone else's allowance.
  if (bump(acGlobal, AC_GLOBAL_MAX, now)) return true;
  let b = acByIp.get(ip);
  if (!b) { b = { count: 0, windowStart: now, last: now }; acByIp.set(ip, b); }
  return bump(b, AC_IP_MAX, now);
}

router.get('/public/places-autocomplete', async (req: Request, res: Response) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  if (acThrottled(acClientIp(req))) {
    // 429 with an empty list: the client treats "no predictions" as a cue to offer
    // manual entry, so a throttled visitor still gets a working funnel.
    res.status(429).json({ predictions: [] });
    return;
  }
  try {
    res.json({ predictions: await placesAutocomplete(q) });
  } catch {
    res.json({ predictions: [] });
  }
});

export default router;
