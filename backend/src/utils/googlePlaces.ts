// Google Places "Place Details" lookup used at signup to auto-populate a garage's
// company info, phone, website and opening hours from the Google Places link the
// customer picked on the marketing site.
//
// The marketing site only does client-side autocomplete (name + address). To get
// phone/website/hours we call the Place Details API server-side. We reuse the same
// Google Maps key the marketing site already uses (it must have the Places API +
// billing enabled). All failures are non-fatal — signup must never break because
// Google was slow or the key lacks a scope.

const PLACES_KEY =
  process.env.GOOGLE_PLACES_API_KEY ||
  process.env.GOOGLE_MAPS_API_KEY ||
  process.env.PUBLIC_GOOGLE_MAPS_API_KEY ||
  '';

const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
type DayKey = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';

export type DailyOpeningHours = { open: string | null; close: string | null; closed: boolean };
export type WeeklyOpeningHours = Record<DayKey, DailyOpeningHours>;

export interface PlaceDetails {
  name?: string;
  address?: string;
  phone?: string;
  website?: string;
  weeklyOpeningHours?: WeeklyOpeningHours;
  businessType?: string;
}

/**
 * Turn Google's place `types` into the phrase the voice agent uses to say what this business is.
 *
 * The agent used to call every customer "a UK car repair garage", which is true of nearly all of
 * them and false of the ones that also sell cars -- Kestrels told a caller they don't sell cars
 * while sitting on FAQs saying they've sold them for thirty years. Google already draws the
 * distinction (`car_dealer` alongside `car_repair`), so take it from there rather than asking.
 *
 * Returns undefined when Google says nothing useful, so the caller keeps the repair-garage
 * default and an unrecognised listing can never leave a garage worse off than before.
 */
export function businessTypeFromPlaceTypes(types?: string[] | null): string | undefined {
  if (!Array.isArray(types) || !types.length) return undefined;
  const has = (t: string) => types.includes(t);
  const dealer = has('car_dealer');
  const repair = has('car_repair');
  if (dealer && repair) return 'a UK car dealership and repair garage';
  if (dealer) return 'a UK car dealership';
  if (repair) return 'a UK car repair garage';
  return undefined;
}

function allClosed(): WeeklyOpeningHours {
  return {
    monday: { open: null, close: null, closed: true },
    tuesday: { open: null, close: null, closed: true },
    wednesday: { open: null, close: null, closed: true },
    thursday: { open: null, close: null, closed: true },
    friday: { open: null, close: null, closed: true },
    saturday: { open: null, close: null, closed: true },
    sunday: { open: null, close: null, closed: true },
  };
}

// "0930" -> "09:30"
function hhmm(t?: string): string | null {
  if (!t || !/^\d{4}$/.test(t)) return null;
  return `${t.slice(0, 2)}:${t.slice(2)}`;
}

// Map Google opening_hours.periods (day 0=Sunday, time "HHMM") into our weekly shape.
// Split shifts collapse to earliest open + latest close for the day. A 24h place
// (single period, open day with time "0000" and no close) becomes 00:00–23:59.
export function mapOpeningHours(periods: any[] | undefined): WeeklyOpeningHours | undefined {
  if (!Array.isArray(periods) || periods.length === 0) return undefined;
  const week = allClosed();

  // 24/7 special case: a lone period with an open and no close.
  if (periods.length === 1 && periods[0]?.open && !periods[0]?.close) {
    for (const d of DAY_KEYS) week[d as DayKey] = { open: '00:00', close: '23:59', closed: false };
    return week;
  }

  for (const p of periods) {
    const openDay = p?.open?.day;
    if (typeof openDay !== 'number' || openDay < 0 || openDay > 6) continue;
    const key = DAY_KEYS[openDay] as DayKey;
    const open = hhmm(p?.open?.time);
    // close may roll into the next day; we keep the close time on the open day.
    const close = hhmm(p?.close?.time) ?? '23:59';
    if (!open) continue;
    const cur = week[key];
    if (cur.closed) {
      week[key] = { open, close, closed: false };
    } else {
      // earliest open, latest close across split shifts
      if (open < (cur.open ?? '99:99')) cur.open = open;
      if (close > (cur.close ?? '00:00')) cur.close = close;
    }
  }
  return week;
}

// Fetch place details. Returns null if there's no key, no placeId, or the call fails.
export async function fetchPlaceDetails(placeId: string | undefined | null): Promise<PlaceDetails | null> {
  const id = (placeId || '').trim();
  if (!id || !PLACES_KEY) {
    if (id && !PLACES_KEY) console.warn('[PLACES] place_id supplied but no Google key configured — skipping details lookup');
    return null;
  }
  try {
    // Places API (NEW). The legacy /maps/api/place/* endpoints are being retired and are no
    // longer enabled on new projects — ours returned "You're calling a legacy API, which is not
    // enabled for your project" while the v1 endpoint answered the identical query fine.
    //
    // The field mask is mandatory here and is what you are billed on, so it asks for exactly
    // what the signup auto-populate uses and nothing more. `types` still comes along for the
    // dealership-vs-repair distinction.
    const mask = [
      'displayName',
      'formattedAddress',
      'nationalPhoneNumber',
      'internationalPhoneNumber',
      'websiteUri',
      'regularOpeningHours',
      'types',
    ].join(',');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const resp = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(id)}`, {
      headers: { 'X-Goog-Api-Key': PLACES_KEY, 'X-Goog-FieldMask': mask },
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
    const data: any = await resp.json();
    if (!resp.ok || data?.error) {
      console.warn(`[PLACES] details lookup failed: HTTP ${resp.status} ${data?.error?.message || ''}`);
      return null;
    }
    return {
      name: data.displayName?.text || undefined,
      address: data.formattedAddress || undefined,
      phone: data.internationalPhoneNumber || data.nationalPhoneNumber || undefined,
      website: data.websiteUri || undefined,
      // v1 periods keep the same {open:{day,hour,minute}, close:{...}} shape, but split hour and
      // minute into separate numbers where the legacy API gave a single "HHMM" string.
      weeklyOpeningHours: mapOpeningHours(normalisePeriods(data.regularOpeningHours?.periods)),
      businessType: businessTypeFromPlaceTypes(data.types),
    };
  } catch (err) {
    console.error('[PLACES] details lookup failed:', err);
    return null;
  }
}

/** v1 gives {hour, minute} numbers; mapOpeningHours expects the legacy "HHMM" string. */
function normalisePeriods(periods: any[] | undefined): any[] | undefined {
  if (!Array.isArray(periods)) return undefined;
  const pad = (n: unknown) => String(typeof n === 'number' ? n : 0).padStart(2, '0');
  const side = (s: any) =>
    s && typeof s.day === 'number' ? { day: s.day, time: `${pad(s.hour)}${pad(s.minute)}` } : undefined;
  return periods.map((p) => ({ open: side(p?.open), close: side(p?.close) }));
}

export const hasPlacesKey = (): boolean => Boolean(PLACES_KEY);

export interface PlacePrediction {
  placeId: string;
  description: string;
  // Google's two-line split ("Kwik Fit" / "London Road, Kingston"). The marketing
  // get-started list renders them as separate lines, so pass them through rather
  // than making the client re-split `description` on the first comma.
  mainText?: string;
  secondaryText?: string;
}

// Type-ahead autocomplete (UK establishments) used by the admin quick-onboard
// modal so staff can pick the customer's Google listing and auto-fill the agent
// config. Proxied through the backend so the browser never needs a Maps key.
export async function placesAutocomplete(query: string): Promise<PlacePrediction[]> {
  const q = (query || '').trim();
  if (q.length < 3 || !PLACES_KEY) return [];
  try {
    // Places API (NEW) — see fetchPlaceDetails for why the legacy endpoint is gone.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const resp = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': PLACES_KEY },
      body: JSON.stringify({
        input: q,
        includedRegionCodes: ['gb'],
        includedPrimaryTypes: ['establishment'],
      }),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
    const data: any = await resp.json();
    if (!resp.ok || data?.error) {
      console.warn(`[PLACES] autocomplete failed: HTTP ${resp.status} ${data?.error?.message || ''}`);
      return [];
    }
    // No suggestions is a legitimate empty answer, not a failure — the old ZERO_RESULTS.
    return (data.suggestions || [])
      .map((s: any) => s?.placePrediction)
      .filter((p: any) => p?.placeId)
      .slice(0, 6)
      .map((p: any) => ({
        placeId: p.placeId,
        description: p.text?.text || p.structuredFormat?.mainText?.text || '',
        mainText: p.structuredFormat?.mainText?.text || undefined,
        secondaryText: p.structuredFormat?.secondaryText?.text || undefined,
      }));
  } catch (err) {
    console.error('[PLACES] autocomplete failed:', err);
    return [];
  }
}

/*
 * Find a garage's Google listing from its name and postcode.
 *
 * This is the half of the Places spend that used to happen at SEED time, for every prospect on
 * the shortlist, and it is the expensive half: a Text Search costs roughly six times a details
 * lookup, and ~94% of prospects never click. Resolving the listing HERE means a shortlist of any
 * size can be seeded for nothing and only clickers are billed.
 *
 * Acceptance is deliberately strict, for the same reason the prospecting matcher is: Google
 * returns a confident result for any string, and a wrong address or phone number is then spoken
 * to the garage as fact in the first minute of their own demo. A match needs the postcode to line
 * up AND the name to resemble the listing, or it is refused and the agent is built knowing
 * nothing — which it handles, by simply never claiming an address.
 *
 * Measured on 3,553 of the Oct-2026 shortlist: 88% proven, 12% refused, and the refusals were
 * right to refuse (Think One Limited -> "Group 1 Ford Basingstoke", R G M -> a different RGM).
 */

/** Words that cannot distinguish one garage from another, so they are not evidence of a match. */
const PLACE_GENERIC = new Set([
  'ltd', 'limited', 'llp', 'plc', 'the', 'and', 'co', 'company', 'uk', 't', 'a',
  'garage', 'garages', 'service', 'services', 'centre', 'center', 'motors', 'motor',
  'auto', 'autos', 'automotive', 'mot', 'mots', 'car', 'cars', 'vehicle', 'vehicles',
  'repair', 'repairs', 'tyre', 'tyres', 'specialists', 'specialist', 'engineers',
]);

const placeNorm = (s: string): string =>
  (s || '').toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

const placeTokens = (s: string): string[] => placeNorm(s).split(' ').filter(Boolean);

const placeDistinctive = (s: string): Set<string> =>
  new Set(placeTokens(s).filter((t) => !PLACE_GENERIC.has(t)));

/** Postcodes compare without their space: "HU152SL" and "HU15 2SL" are the same postcode. */
const squashPostcode = (s: string): string => (s || '').toUpperCase().replace(/\s+/g, '');

/** The outward code alone ("HU15"), which is as far as a partial address can be trusted. */
const outwardCode = (postcode: string): string => {
  const sq = squashPostcode(postcode);
  return sq.length > 3 ? sq.slice(0, sq.length - 3) : '';
};

/** True when the listing's address carries the postcode we searched for. */
export function addressHasPostcode(address: string | undefined, postcode: string): 'full' | 'outward' | 'none' {
  const addr = squashPostcode(address || '');
  if (!addr) return 'none';
  const full = squashPostcode(postcode);
  if (full && addr.includes(full)) return 'full';
  const out = outwardCode(postcode);
  return out && addr.includes(out) ? 'outward' : 'none';
}

/**
 * True when the listing's name is plausibly the business we searched for.
 *
 * A fuller trading name is fine ("AD Car Care Wimbledon Limited" -> "AD Car Care Ltd"), and so is
 * an initialism Google has spaced out ("TLS Peacehaven" -> "T L S Peacehaven Ltd"). Half the
 * distinctive words is the floor; below that the postcode is doing all the work and a neighbouring
 * business would pass.
 */
export function placeNameResembles(searched: string, got: string): boolean {
  const want = placeDistinctive(searched);
  const have = new Set(placeTokens(got));
  if (want.size > 0 && [...want].every((t) => have.has(t))) return true;
  const squash = (x: string) => placeNorm(x).replace(/\s/g, '');
  if (squash(searched) && squash(searched) === squash(got)) return true;
  // Containment, but only when the shorter side still says WHICH business. Without that guard a
  // listing literally called "Garage" is contained in "Newtown Garage" and matches it, which is
  // the same hole that once resolved "Alex Caldwell" to "Caldwell" and handed over a London
  // number. The postcode gate limits the damage; it does not close it, because an outward code
  // covers a whole town.
  const a = placeNorm(searched);
  const b = placeNorm(got);
  if (a && b && (a.includes(b) || b.includes(a))) {
    const shorter = a.length <= b.length ? searched : got;
    if (placeDistinctive(shorter).size > 0) return true;
  }
  if (want.size === 0) return false;
  const overlap = [...want].filter((t) => have.has(t)).length;
  return overlap >= Math.max(1, Math.floor(want.size / 2));
}

export interface ResolvedPlace {
  placeId: string;
  name?: string;
  address?: string;
  phone?: string;
  website?: string;
  /** How the match was proven, so a bad batch is traceable in the logs. */
  matchedOn: 'postcode+name' | 'outward+name';
}

export async function findPlaceByNameAndPostcode(
  name: string,
  postcode: string,
): Promise<ResolvedPlace | null> {
  const q = `${(name || '').trim()} ${(postcode || '').trim()} UK`.trim();
  if (!name?.trim() || !postcode?.trim() || !PLACES_KEY) return null;
  try {
    // The field mask is what you are billed on. websiteUri is here on purpose: for a garage whose
    // only contact detail is a free-mail address, the listing is the ONLY source of their website,
    // and the website is what the knowledge scrape is built from.
    const mask = [
      'places.id',
      'places.displayName',
      'places.formattedAddress',
      'places.nationalPhoneNumber',
      'places.internationalPhoneNumber',
      'places.websiteUri',
    ].join(',');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const resp = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': PLACES_KEY, 'X-Goog-FieldMask': mask },
      body: JSON.stringify({ textQuery: q, maxResultCount: 5, includedType: 'car_repair', strictTypeFiltering: false }),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
    const data: any = await resp.json();
    if (!resp.ok || data?.error) {
      console.warn(`[PLACES] text search failed: HTTP ${resp.status} ${data?.error?.message || ''}`);
      return null;
    }
    const results: any[] = Array.isArray(data.places) ? data.places : [];
    // Prefer a full postcode match over an outward one, so a better candidate further down the
    // list still wins over a weaker first hit.
    let fallback: ResolvedPlace | null = null;
    for (const p of results) {
      const got = p?.displayName?.text || '';
      if (!p?.id || !placeNameResembles(name, got)) continue;
      const how = addressHasPostcode(p?.formattedAddress, postcode);
      if (how === 'none') continue;
      const hit: ResolvedPlace = {
        placeId: p.id,
        name: got || undefined,
        address: p.formattedAddress || undefined,
        phone: p.internationalPhoneNumber || p.nationalPhoneNumber || undefined,
        website: p.websiteUri || undefined,
        matchedOn: how === 'full' ? 'postcode+name' : 'outward+name',
      };
      if (how === 'full') return hit;
      if (!fallback) fallback = hit;
    }
    if (!fallback) {
      const top = results[0]?.displayName?.text || '(nothing)';
      console.log(`[PLACES] no provable match for "${name}" ${postcode} — top result was "${top}"`);
    }
    return fallback;
  } catch (err) {
    console.error('[PLACES] text search failed:', err);
    return null;
  }
}
