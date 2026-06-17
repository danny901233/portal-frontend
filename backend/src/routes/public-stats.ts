// Public, anonymized stats endpoints for the marketing site. NO authentication.
// Returns only city + service + relative age — never garage names, caller info,
// phone numbers, registration plates or timestamps that could identify a call.

import type { Request, Response } from 'express';
import { Router } from 'express';
import { prisma } from '../db.js';

const router = Router();

// In-memory cache so a spike of marketing-site traffic never hammers the DB.
let cache: { data: PublicCallEntry[]; expiresAt: number } | null = null;
const CACHE_MS = 60_000;

interface PublicCallEntry {
  agent: string;
  city: string;
  // Pre-composed description like "an MOT booking" or "a general enquiry"
  // so the marketing site can render "[Agent] handled [description] for a
  // garage in [city]" without doing any business logic.
  description: string;
  ageMinutes: number;
}

router.get('/public/recent-calls', async (_req: Request, res: Response) => {
  // Public + cacheable.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=60');

  if (cache && cache.expiresAt > Date.now()) {
    return res.json(cache.data);
  }

  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const calls = await prisma.call.findMany({
      where: {
        createdAt: { gte: since },
        // Skip very short calls — usually hangups; not worth showcasing
        durationSeconds: { gte: 30 },
      },
      select: {
        createdAt: true,
        callType: true,
        confirmedBooking: true,
        confirmedBookingCategory: true,
        garage: {
          select: {
            name: true,
            agentConfiguration: { select: { branchAddress: true, voice: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      // 50 wasn't enough — many recent calls are "other"/"unknown"/"message_only"
      // and get filtered downstream, so we need a fatter window to guarantee
      // the ticker has rows.
      take: 250,
    });

    const now = Date.now();
    const seen = new Set<string>();
    const data: PublicCallEntry[] = [];

    for (const call of calls) {
      const city = extractCity(call.garage?.agentConfiguration?.branchAddress ?? null);
      const description = describeCall(call.callType, call.confirmedBooking, call.confirmedBookingCategory);
      const agent = agentNameFromVoice(call.garage?.agentConfiguration?.voice ?? null);
      if (!city || !description) continue; // skip if we can't compose a good line

      // De-dupe runs of the exact same line so the ticker doesn't look stuck
      const key = `${agent}|${city}|${description}`;
      if (seen.has(key)) continue;
      seen.add(key);

      data.push({
        agent,
        city,
        description,
        ageMinutes: Math.max(0, Math.floor((now - call.createdAt.getTime()) / 60_000)),
      });
    }

    cache = { data, expiresAt: now + CACHE_MS };
    return res.json(data);
  } catch (err) {
    console.error('[PUBLIC_STATS] recent-calls failed:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

// Best-effort city extraction from a free-text branch address. UK addresses
// usually end in "..., City, Postcode" or "City Postcode". We strip the
// postcode, then walk the comma-delimited parts from the end and return
// the first one that doesn't look like a street.
const STREET_SUFFIXES = [
  'street', 'st', 'road', 'rd', 'lane', 'ln', 'avenue', 'ave', 'drive', 'dr',
  'close', 'cl', 'way', 'court', 'ct', 'gardens', 'gdns', 'place', 'pl',
  'crescent', 'cres', 'park', 'square', 'sq', 'terrace', 'mews', 'walk',
  'estate', 'industrial', 'park', 'business', 'retail',
];
const STREET_RE = new RegExp(`\\b(${STREET_SUFFIXES.join('|')})\\b\\.?$`, 'i');

// UK ceremonial counties + the larger administrative ones. Addresses typically
// list "..., City, County, Postcode" — so when walking the parts from the end
// we must skip counties to land on the actual city.
const UK_COUNTIES = new Set([
  'aberdeenshire', 'anglesey', 'angus', 'argyll and bute', 'avon',
  'bedfordshire', 'berkshire', 'borders', 'buckinghamshire',
  'caithness', 'cambridgeshire', 'carmarthenshire', 'ceredigion',
  'cheshire', 'clackmannanshire', 'cleveland', 'clwyd', 'conwy',
  'cornwall', 'county antrim', 'county armagh', 'county down',
  'county durham', 'county fermanagh', 'county londonderry', 'county tyrone',
  'cumbria', 'denbighshire', 'derbyshire', 'devon', 'dorset',
  'dumfries and galloway', 'dunbartonshire', 'durham',
  'east lothian', 'east riding of yorkshire', 'east sussex', 'essex',
  'fife', 'flintshire', 'gloucestershire', 'greater london',
  'greater manchester', 'gwent', 'gwynedd', 'hampshire', 'herefordshire',
  'hertfordshire', 'highland', 'inverclyde', 'isle of wight', 'kent',
  'lanarkshire', 'lancashire', 'leicestershire', 'lincolnshire',
  'merseyside', 'mid glamorgan', 'midlothian', 'monmouthshire', 'moray',
  'norfolk', 'north yorkshire', 'northamptonshire', 'northumberland',
  'nottinghamshire', 'orkney', 'oxfordshire', 'pembrokeshire',
  'perth and kinross', 'powys', 'renfrewshire', 'rutland',
  'scottish borders', 'shetland', 'shropshire', 'somerset',
  'south ayrshire', 'south glamorgan', 'south yorkshire', 'staffordshire',
  'stirling', 'suffolk', 'surrey', 'sussex', 'tyne and wear',
  'warwickshire', 'west glamorgan', 'west lothian', 'west midlands',
  'west sussex', 'west yorkshire', 'western isles', 'wiltshire',
  'worcestershire', 'wrexham',
]);

function extractCity(address: string | null): string | null {
  if (!address) return null;
  const postcodeRe = /\b[A-Z]{1,2}\d{1,2}[A-Z]?\s*\d[A-Z]{2}\b/i;
  const noPostcode = address.replace(postcodeRe, '').trim();
  const parts = noPostcode
    .split(/[,\n]/)
    .map((p) => p.trim().replace(/\.$/, '')) // strip trailing "."
    .filter((p) => p.length > 1 && p.length < 40);
  if (parts.length === 0) return null;

  // Walk from the end; the city is usually the last non-street, non-county part.
  for (let i = parts.length - 1; i >= 0; i--) {
    const candidate = parts[i];
    if (/^\d/.test(candidate)) continue; // leading digits = address line / phone
    if (STREET_RE.test(candidate)) continue; // ends in a street word
    if (/^(unit|suite|flat|building|block)\b/i.test(candidate)) continue;
    if (UK_COUNTIES.has(candidate.toLowerCase())) continue; // skip county names
    return toTitleCase(candidate);
  }
  return null;
}

function toTitleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/(\s+|-)/)
    .map((part) => (/^[a-z]/.test(part) ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join('');
}

// Returns a noun phrase that slots into "[Agent] handled X for a garage in Y".
// Confirmed bookings get the most specific framing; non-confirmed calls fall
// back to the callType label. Returns null when we'd just say "a call" — we'd
// rather skip a vague row than show it.
function describeCall(
  callType: string,
  confirmedBooking: boolean,
  category: string | null,
): string | null {
  if (confirmedBooking) {
    switch ((category ?? '').toLowerCase()) {
      case 'mot':
        return 'an MOT booking';
      case 'service':
        return 'a service booking';
      case 'diagnostic':
        return 'a diagnostic appointment';
      default:
        return 'a booking';
    }
  }
  // Real-world callType values seen in prod: "general enquiry" (space-sep),
  // "message"/"message_only", "other", "unknown", "vehicle_update", etc.
  // We normalise spaces/hyphens/underscores so a single case label covers
  // all the variants of the same intent.
  const t = (callType ?? '').toLowerCase().replace(/[\s_-]+/g, '');
  switch (t) {
    case 'enquiry':
    case 'general':
    case 'generalenquiry':
      return 'a general enquiry';
    case 'update':
    case 'vehicleupdate':
      return 'an update call';
    case 'booking':
    case 'confirmedbooking':
      return 'a booking enquiry';
    case 'callback':
    case 'humanrequest':
      return 'a callback request';
    case 'price':
    case 'quote':
      return 'a price enquiry';
    case 'message':
    case 'messageonly':
      return 'a message for the team';
    default:
      // Don't filter the row out — show a generic line. Prevents the ticker
      // collapsing to empty just because a few callType strings are unknown.
      return 'a call';
  }
}

// Map the voice field (lowercase) to a capitalised name for display.
// Defaults to "Leah" — our most common voice — when unset.
const KNOWN_VOICES = new Set([
  'tom', 'leah', 'sophie', 'gemma', 'isobel', 'fraser', 'amelia',
]);
function agentNameFromVoice(voice: string | null): string {
  const v = (voice ?? '').toLowerCase();
  if (!v || !KNOWN_VOICES.has(v)) return 'Leah';
  return v.charAt(0).toUpperCase() + v.slice(1);
}

export default router;
