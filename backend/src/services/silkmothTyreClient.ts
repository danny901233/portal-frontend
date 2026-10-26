/**
 * Silkmoth / "Tyres & Service" tyre-price client (READ ONLY).
 *
 * Silkmoth (now part of Klipboard) builds and hosts the tyre sites sold as "Tyres &
 * Service", branded TyreClick on the customer's own domain. On 2026-10-26 both the garage
 * (Tam Tyres) and Silkmoth agreed we may read a garage's own tyre prices to quote them on
 * inbound calls. This client does that and nothing else: there is no basket, no booking and
 * no write path of any kind, so none of the dryRun machinery CAM needed applies here.
 *
 * Note their robots.txt disallows /tyresearch/results, /vrnsearch/ and /services.asmx to
 * `User-agent: *`. That is a direction to anonymous crawlers; we are an identified, invited
 * integration, which is why USER_AGENT below names us and links back. Keep it that way — if
 * anyone at Silkmoth wonders what the traffic is, they should be able to tell at a glance
 * and ring us rather than block us.
 *
 * ── STATUS: modelled from a real capture (Tam Tyres / Dunston Tyres, 2026-10-26) ─────────
 * Both endpoints were driven live and their responses read: a size search (205/55R16, 19
 * priced results) and a registration search (V20ALA -> Land Rover Range Rover Evoque ->
 * 235/60R18 V, 15 priced results). Every field name, URL and price basis below is observed,
 * not guessed. Nothing here infers a request shape.
 *
 * ── How it talks (observed) ──────────────────────────────────────────────────────────────
 * Two plain GETs against the garage's own hostname. No session, no cookie, no POST, no XHR:
 * the results page is server-rendered and the prices arrive in the initial response.
 *
 *   GET /tyresearch/results?width=205&profile=55&rim=16[&speed=V]
 *   GET /vrnsearch/details?VRN=V20ALA
 *       -> 302 /vrnsearch/results?width=235&profile=60&rim=18
 *                                &make=LAND%20ROVER&model=RANGE%20ROVER%20EVOQUE...&speed=V
 *
 * The registration route is the one worth using on a call. One request turns a reg into the
 * make, the model, the tyre size AND the priced results — callers know their number plate,
 * they do not know "235/60R18".  The vehicle is read back off the redirect's query string,
 * which is why fetch() must be allowed to follow redirects and the final URL inspected.
 *
 * ── Prices are FULLY FITTED, per tyre ────────────────────────────────────────────────────
 * Each result carries `<strong class="...result-price...">` followed by the literal label
 * "Fully fitted price per tyre". That is the out-the-door number — fitting, valve, balance
 * and disposal included — so it is the right figure to say out loud. Do not add to it, and
 * do not describe it as "plus fitting".
 *
 * ── Per garage, the only variable is the hostname ────────────────────────────────────────
 * Unlike CAM there is no per-site api key or widget id. A garage's config needs one field,
 * its Tyres & Service hostname, e.g. www.dunstontyres.co.uk. Note it is NOT always the
 * garage's main domain: tamtyres.co.uk is a brochure site whose widget is configured with
 * `site: "www.dunstontyres.co.uk"`, and the prices live on the latter.
 *
 * ── Caching ──────────────────────────────────────────────────────────────────────────────
 * Tyre prices do not move hourly and a results page is ~290KB, so every lookup is cached for
 * CACHE_TTL_MS keyed on host+size. A live call must never wait on a cold third-party fetch
 * twice for the same size, and we must not hammer a host we were invited to read politely.
 */

const USER_AGENT =
  'ReceptionMate/1.0 (+https://receptionmate.co.uk; authorised tyre-price integration)';

/** A slow third party must never hold a phone call open. */
const FETCH_TIMEOUT_MS = 6000;
const CACHE_TTL_MS = 60 * 60 * 1000;

export const SILKMOTH_ENDPOINTS = {
  /** Size search. Returns the priced results page directly. */
  sizeSearch: '/tyresearch/results',
  /** Registration search. 302s to /vrnsearch/results with the size + vehicle in the query. */
  vrnSearch: '/vrnsearch/details',
} as const;

export interface SilkmothCreds {
  /** The garage's Tyres & Service hostname, no scheme. e.g. www.dunstontyres.co.uk */
  site: string;
}

export interface TyreSize {
  width: number;
  profile: number;
  rim: number;
  /** Speed rating where the site gave us one, e.g. "V". */
  speed?: string;
}

export interface SilkmothVehicle extends TyreSize {
  make?: string;
  model?: string;
}

export interface TyreQuote {
  /** Site's own product id, stable enough to dedupe on. */
  productId: string;
  /** "Falken Azenis FK520 SUV" — derived from the product slug. */
  name: string;
  /** Fully fitted, per tyre, in pounds. */
  priceGbp: number;
  detailUrl: string;
}

export interface TyreQuoteResult {
  size: TyreSize;
  vehicle?: SilkmothVehicle;
  quotes: TyreQuote[];
}

/** Read a garage's config into creds, or null when it is not a Silkmoth garage. */
export function silkmothCredsFromConfig(config: unknown): SilkmothCreds | null {
  if (!config || typeof config !== 'object') return null;
  const raw = (config as Record<string, unknown>).silkmothSite
    ?? (config as Record<string, unknown>).tyresAndServiceSite;
  const site = typeof raw === 'string' ? raw.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '') : '';
  return site ? { site } : null;
}

export function formatSize(s: TyreSize): string {
  return `${s.width}/${s.profile}R${s.rim}${s.speed ? ` ${s.speed}` : ''}`;
}

const cache = new Map<string, { at: number; value: TyreQuoteResult }>();

function cached(key: string): TyreQuoteResult | null {
  const hit = cache.get(key);
  if (!hit || Date.now() - hit.at > CACHE_TTL_MS) return null;
  return hit.value;
}

async function get(url: string): Promise<{ html: string; finalUrl: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
    });
    if (!res.ok) throw new Error(`silkmoth ${res.status} for ${url}`);
    return { html: await res.text(), finalUrl: res.url };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pull the priced results out of a rendered results page.
 *
 * Each card is anchored on its product link; the price sits a little further into the same
 * card as two spans, the entity and the amount. We walk product links in document order and
 * take the first price after each, which is what the markup guarantees. Dedupe on product
 * id: a tyre listed in two widths appears twice on the page.
 */
function parseQuotes(html: string, site: string): TyreQuote[] {
  const out: TyreQuote[] = [];
  const seen = new Set<string>();
  const link = /href="(\/tyresearch\/details\/(\d+)\/([a-z0-9-]+))"/g;
  for (let m = link.exec(html); m; m = link.exec(html)) {
    const [, path, productId, slug] = m;
    if (seen.has(productId)) continue;
    const card = html.slice(m.index, m.index + 4000);
    const price = /result-price[^>]*>\s*<span>&pound;<\/span><span>([\d.,]+)<\/span>/.exec(card);
    if (!price) continue;
    const value = Number(price[1].replace(/,/g, ''));
    if (!Number.isFinite(value)) continue;
    seen.add(productId);
    out.push({
      productId,
      name: slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      priceGbp: value,
      detailUrl: `https://${site}${path}`,
    });
  }
  return out.sort((a, b) => a.priceGbp - b.priceGbp);
}

/** Read size + vehicle back off the results URL the site redirected us to. */
function sizeFromUrl(finalUrl: string): SilkmothVehicle | null {
  let q: URLSearchParams;
  try { q = new URL(finalUrl).searchParams; } catch { return null; }
  const width = Number(q.get('width'));
  const profile = Number(q.get('profile'));
  const rim = Number(q.get('rim'));
  if (!width || !profile || !rim) return null;
  return {
    width, profile, rim,
    speed: q.get('speed') || undefined,
    make: q.get('make') || undefined,
    model: q.get('model') || undefined,
  };
}

export class SilkmothTyreClient {
  constructor(private readonly creds: SilkmothCreds) {}

  /** Quote by tyre size, when the caller already knows it. */
  async quoteBySize(size: TyreSize): Promise<TyreQuoteResult> {
    const key = `${this.creds.site}|${formatSize(size)}`;
    const hit = cached(key);
    if (hit) return hit;

    const q = new URLSearchParams({
      width: String(size.width), profile: String(size.profile), rim: String(size.rim),
    });
    if (size.speed) q.set('speed', size.speed);
    const { html } = await get(`https://${this.creds.site}${SILKMOTH_ENDPOINTS.sizeSearch}?${q}`);

    const value: TyreQuoteResult = { size, quotes: parseQuotes(html, this.creds.site) };
    cache.set(key, { at: Date.now(), value });
    return value;
  }

  /**
   * Quote by registration — the one to use on a call.
   *
   * One request returns the vehicle AND its priced tyres, because the site resolves the reg
   * and redirects to the results. Returns null when the reg does not resolve, so the agent
   * can ask for the size instead of inventing one.
   */
  async quoteByRegistration(registration: string): Promise<TyreQuoteResult | null> {
    const vrn = registration.toUpperCase().replace(/\s+/g, '');
    if (!vrn) return null;
    const key = `${this.creds.site}|vrn:${vrn}`;
    const hit = cached(key);
    if (hit) return hit;

    const url = `https://${this.creds.site}${SILKMOTH_ENDPOINTS.vrnSearch}?VRN=${encodeURIComponent(vrn)}`;
    const { html, finalUrl } = await get(url);

    const vehicle = sizeFromUrl(finalUrl);
    if (!vehicle) return null;

    const quotes = parseQuotes(html, this.creds.site);
    if (!quotes.length) return null;

    const value: TyreQuoteResult = {
      size: { width: vehicle.width, profile: vehicle.profile, rim: vehicle.rim, speed: vehicle.speed },
      vehicle,
      quotes,
    };
    cache.set(key, { at: Date.now(), value });
    return value;
  }
}
