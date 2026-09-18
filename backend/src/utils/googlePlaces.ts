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

export interface PlacePrediction { placeId: string; description: string; }

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
      .map((p: any) => ({ placeId: p.placeId, description: p.text?.text || p.structuredFormat?.mainText?.text || '' }));
  } catch (err) {
    console.error('[PLACES] autocomplete failed:', err);
    return [];
  }
}
