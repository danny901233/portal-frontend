/**
 * Bosch Car Service online-booking client — the "Mobility Media" platform.
 *
 * The boschcarservice.com "Book now" page is a shell; the booking engine is Bosch's own
 * platform at `gateway.mobility-media.cloud`, tenant `BCSUK`, a clean versioned REST API
 * shared by ~20 Bosch country sites. Auth is a single static `api-token` baked into the
 * page JS, sent as an `api-token` header; the gateway is CORS-fussy and answers 403 without
 * an allowed `Origin`. No session, no cookie, no OAuth for the READ and BOOKING paths.
 *
 * ── STATUS: built from a real end-to-end capture (Pd Vehicle Services, V20ALA, 2026-10-12) ──
 * Every READ call here was run from the command line and its response shape observed:
 * garage+price search, per-service pricing, available days, bookable slots. The WRITE path
 * — create cart -> attach vehicle -> lock slot -> checkout — was ALSO run end to end and
 * produced a real booking (code AATBS3) at Pd Vehicle Services, then had to be cancelled by
 * hand. So unlike the CAM capture, the write envelopes here are OBSERVED, not inferred.
 *
 * ── What that capture taught us (and corrected) ──────────────────────────────
 * 1. vehicle-ident on the cart takes a PLAIN plate and needs NO captcha. hCaptcha only
 *    guards the vehicle-IDENTIFICATION/display calls (make/model/age lookup), a separate
 *    service we do NOT touch. So we can book against a reg blind.
 * 2. A slot from slots/search-all carries NO id. Checkout requires `timeSlot.id`. The id is
 *    minted by LOCKING the slot: POST blocked-resource/spo/{spo} with the slot's `services`
 *    array returns `{ id, status:"BLOCKED" }`, and THAT id is the timeSlot id. The lock
 *    holds a real resource in the diary the moment it is taken — see commitMode in bosch.ts.
 * 3. CHECKOUT is anonymous (the static token books fine) but CANCEL / RETRIEVE / RESCHEDULE
 *    are NOT: `booking/{code}/cancel` returns 401 Access Denied and `by-token` wants a UUID
 *    we are never handed — only the 6-char bookingCode. Cancellation needs the per-booking
 *    token from the customer's confirmation email, or a MyBCS login. An agent that books
 *    here therefore CANNOT un-book. That is why the adapter declares cancel/reschedule off.
 * 4. Pricing splits by service_type:
 *      fixprice  (MOT 18005, Tyre 18006/7, Air-con 18008, checks 18009/10) — priced with NO
 *                vehicle, via servicepointsearch/price-search.
 *      calcprice (Car Servicing 18001, Oil 18002, Timing belt 18003, Brakes 18004) — priced
 *                via servicepointsearch/acc-price-search, which REQUIRES `brand` and `age`.
 *                Those come from the vehicle; a bare reg is not enough, so calcprice quoting
 *                needs brand+age supplied from elsewhere (the display lookup is captcha-gated).
 *      classic   (Maintenance & Service Enquiry 18000) — no price, date + free-text only.
 *    A garage can switch pricing off per service (`noPriceOptionActive`), e.g. Pd Vehicle
 *    Services is enquiry-only (classicServices:["18000"]).
 */

const DEFAULT_GATEWAY = 'https://gateway.mobility-media.cloud';
/** The static client token lifted from the BCSUK booking widget. Overridable per garage in
 *  case Bosch rotates it or issues a tenant-specific one. */
const DEFAULT_API_TOKEN = '0196fbea-1d11-4fb7-b2ae-4946280f10fb';
const ORIGIN = 'https://app.mobility-media.cloud';

/** Catalogue service ids are stable across the BCSUK tenant (observed 2026-10-12). */
export const BCS_SERVICES: Record<number, { name: string; type: 'fixprice' | 'calcprice' | 'classic' }> = {
  18000: { name: 'Maintenance and Service Enquiry', type: 'classic' },
  18001: { name: 'Car Servicing', type: 'calcprice' },
  18002: { name: 'Oil and Filter Change', type: 'calcprice' },
  18003: { name: 'Timing Belt', type: 'calcprice' },
  18004: { name: 'Brake Service', type: 'calcprice' },
  18005: { name: 'MOT', type: 'fixprice' },
  18006: { name: 'Tyre Service', type: 'fixprice' },
  18007: { name: 'Tyre mounting', type: 'fixprice' },
  18008: { name: 'Air conditioning service', type: 'fixprice' },
  18009: { name: 'Lighting check', type: 'fixprice' },
  18010: { name: 'Security check', type: 'fixprice' },
};

export interface BoschCreds {
  apiToken: string;
  /** The garage's service-point UUID (its `UUID` in search results). Required — one adapter
   *  instance is one garage, the direct analogue of CAM's branchKey / Poole's branchKey. */
  spoId: string;
  gateway: string;
  /** Approximate lat/long for the price-search calls, which are location-anchored. Defaults
   *  to central London; a wrong value only affects which garages a search RETURNS, and we
   *  filter to spoId anyway, so it is a hint, not a correctness risk. */
  lat: number;
  long: number;
}

export interface BoschSlot {
  /** ISO start, e.g. 2026-11-11T08:00:00Z */
  start: string;
  end: string;
  receptionTime?: string;
  /** The slot's `services` array, passed verbatim to the lock call. */
  services: unknown[];
}

export interface BoschBooking {
  bookingCode: string;
  raw: unknown;
}

export class BoschError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'BoschError';
    this.status = status;
  }
}

export function boschCredsFromConfig(config: unknown): BoschCreds | null {
  const raw = (config && typeof config === 'object' ? config : {}) as any;
  const b = raw.bosch ?? raw;
  const spoId = b.boschSpoId ?? b.spoId ?? raw.boschSpoId;
  if (!spoId) return null;
  return {
    apiToken: String(b.boschApiToken ?? b.apiToken ?? raw.boschApiToken ?? DEFAULT_API_TOKEN),
    spoId: String(spoId),
    gateway: String(b.boschGateway ?? b.gateway ?? DEFAULT_GATEWAY),
    lat: Number(b.boschLat ?? b.lat ?? raw.boschLat ?? 51.5074),
    long: Number(b.boschLong ?? b.long ?? raw.boschLong ?? -0.1278),
  };
}

export class BoschClient {
  constructor(private readonly creds: BoschCreds) {}

  isEnabled(): boolean {
    return Boolean(this.creds?.apiToken && this.creds?.spoId);
  }

  private async call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.creds.gateway + path, {
      method,
      headers: {
        'api-token': this.creds.apiToken,
        'Content-Type': 'application/json',
        Origin: ORIGIN,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any;
    try { json = JSON.parse(text); } catch { json = text; }
    if (!res.ok) {
      const msg = (json && typeof json === 'object' && json.message) ? json.message : text.slice(0, 200);
      throw new BoschError(`Bosch ${method} ${path} -> ${res.status}: ${msg}`, res.status);
    }
    return json as T;
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  /** Fixprice quote for a service at this garage (MOT etc.). Returns the price in GBP, or
   *  undefined if the garage does not price it. No vehicle needed. */
  async fixPrice(serviceId: number): Promise<number | undefined> {
    const q = `lat=${this.creds.lat}&long=${this.creds.long}&serviceId=${serviceId}`
      + `&radius=5&size=50&country=GB&language=en&platform=portal`;
    const r = await this.call<any>('GET', `/servicepointsearch/services/v1/price-search?${q}`);
    const me = (r?.list || []).find((g: any) => g.UUID === this.creds.spoId);
    const p = me?.calculatedPrice;
    return typeof p === 'number' && p > 0 ? p : undefined;
  }

  /** Calcprice quote (Car Servicing etc.). Needs the vehicle's brand and age in years. */
  async calcPrice(serviceId: number, brand: string, ageYears: number): Promise<number | undefined> {
    const q = `lat=${this.creds.lat}&long=${this.creds.long}&serviceId=${serviceId}`
      + `&radius=5&size=50&country=GB&language=en&platform=portal`
      + `&brand=${encodeURIComponent(brand)}&age=${encodeURIComponent(String(ageYears))}`;
    const r = await this.call<any>('GET', `/servicepointsearch/services/v1/acc-price-search?${q}`);
    const me = (r?.list || []).find((g: any) => g.UUID === this.creds.spoId);
    const p = me?.calculatedPrice;
    return typeof p === 'number' && p > 0 ? p : undefined;
  }

  /** Does this garage offer this service, and is it online-bookable? */
  async offersService(serviceId: number): Promise<boolean> {
    const q = `lat=${this.creds.lat}&long=${this.creds.long}&serviceId=${serviceId}&radius=5&size=50`;
    const r = await this.call<any>('GET', `/servicepointsearch/services/v1/spo-by-location?${q}`);
    const me = (r?.list || []).find((g: any) => g.UUID === this.creds.spoId);
    return Boolean(me?.onlineBooking);
  }

  async availableDays(serviceId: number, fromIso: string, toIso: string): Promise<string[]> {
    const r = await this.call<any[]>('POST',
      `/time-slot-finder-v2/services/finder/spo/${this.creds.spoId}/available-days/search?from=${fromIso}&to=${toIso}`,
      [{ id: serviceId }]);
    return (Array.isArray(r) ? r : []).map((d: any) => String(d.date)).filter(Boolean);
  }

  async slots(serviceId: number, fromIso: string, toIso: string): Promise<BoschSlot[]> {
    const r = await this.call<any[]>('POST',
      `/time-slot-finder-v2/services/finder/spo/${this.creds.spoId}/slots/search-all?from=${fromIso}&to=${toIso}`,
      [{ id: serviceId }]);
    return (Array.isArray(r) ? r : [])
      .filter((s: any) => s.bookable)
      .map((s: any) => ({ start: s.start, end: s.end, receptionTime: s.receptionTime, services: s.services || [] }));
  }

  // ── Booking (write path) ─────────────────────────────────────────────────────

  async createCart(serviceId: number): Promise<string> {
    const r = await this.call<any>('POST', '/cart/services/cart', {
      servicePointId: this.creds.spoId,
      locale: 'en_GB',
      articles: [{ articleId: serviceId, articleType: 'SERVICE' }],
    });
    if (!r?.cartId) throw new BoschError('cart creation returned no cartId');
    return r.cartId;
  }

  async attachVehicle(cartId: string, registration: string): Promise<void> {
    await this.call('POST', `/cart/services/cart/${cartId}/vehicle-ident`, {
      identity: {
        licensePlate: { value: registration.toUpperCase().replace(/\s+/g, ''), country: 'GB' },
        registrationDate: { open: false, year: 1900 },
      },
    });
  }

  /** Lock the slot and return the timeSlot id checkout requires. Side-effecting: holds the
   *  resource in the garage's diary until booked or it times out. */
  async lockSlot(slot: BoschSlot): Promise<string> {
    const r = await this.call<any>('POST',
      `/time-slot-finder-v2/services/blocked-resource/spo/${this.creds.spoId}`, slot.services ?? []);
    const id = r?.id ?? (Array.isArray(r) ? r[0]?.id : undefined);
    if (!id) throw new BoschError('slot lock returned no id');
    return String(id);
  }

  async checkout(args: {
    cartId: string; slot: BoschSlot; slotId: string;
    firstName: string; lastName: string; email: string; phone: string;
    problemDescription?: string;
  }): Promise<BoschBooking> {
    const timeSlot: any = { from: args.slot.start, to: args.slot.end, id: args.slotId };
    if (args.slot.receptionTime) timeSlot.receptionTime = args.slot.receptionTime;
    const r = await this.call<any>('POST', '/cart/services/cart/checkout', {
      shoppingCartId: args.cartId,
      consumer: {
        firstName: args.firstName, lastName: args.lastName,
        email: args.email, mobileNumber: args.phone, phoneNumber: args.phone,
        smsNotification: false, whatsAppNotification: false, language: 'en', country: 'GB',
      },
      timeSlot,
      onlinePromotion: false,
      ...(args.problemDescription ? { problemDescription: args.problemDescription } : {}),
    });
    const code = r?.bookingCode || r?.token || r?.id;
    if (!code) throw new BoschError('checkout returned no booking code');
    return { bookingCode: String(code), raw: r };
  }
}

export function boschClientFromConfig(config: unknown): BoschClient | null {
  const creds = boschCredsFromConfig(config);
  return creds ? new BoschClient(creds) : null;
}
