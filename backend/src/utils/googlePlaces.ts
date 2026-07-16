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
    const fields = ['name', 'formatted_address', 'formatted_phone_number', 'international_phone_number', 'website', 'opening_hours'].join(',');
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(id)}&fields=${fields}&key=${encodeURIComponent(PLACES_KEY)}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const resp = await fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
    const data: any = await resp.json();
    if (data?.status !== 'OK' || !data?.result) {
      console.warn(`[PLACES] details lookup non-OK: status=${data?.status} error=${data?.error_message || ''}`);
      return null;
    }
    const r = data.result;
    return {
      name: r.name || undefined,
      address: r.formatted_address || undefined,
      phone: r.international_phone_number || r.formatted_phone_number || undefined,
      website: r.website || undefined,
      weeklyOpeningHours: mapOpeningHours(r.opening_hours?.periods),
    };
  } catch (err) {
    console.error('[PLACES] details lookup failed:', err);
    return null;
  }
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
    const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(q)}&types=establishment&components=country:gb&key=${encodeURIComponent(PLACES_KEY)}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const resp = await fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
    const data: any = await resp.json();
    if (data?.status !== 'OK' && data?.status !== 'ZERO_RESULTS') {
      console.warn(`[PLACES] autocomplete non-OK: status=${data?.status} error=${data?.error_message || ''}`);
      return [];
    }
    return (data.predictions || []).slice(0, 6).map((p: any) => ({ placeId: p.place_id, description: p.description }));
  } catch (err) {
    console.error('[PLACES] autocomplete failed:', err);
    return [];
  }
}
