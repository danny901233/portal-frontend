// GarageHive "connect the diary" flow.
//
// GarageHive gives us one thing: the online-booking INSTANCE (customerId, e.g. "inoplus").
// The API key is shared across all GarageHive garages, so we already hold it. The location id
// is NOT supplied — it's derived by calling the online-booking /init endpoint, which returns the
// instance's location(s). For a single-branch instance that's one location; for a multi-branch
// instance (e.g. In'n'out under "inoplus") it returns them all, and we pick the right branch for
// each Garage record by matching the garage's own name/address — because WE know which branch we
// onboarded (from the agreement + garage records) and GarageHive does not.
import { prisma } from '../db.js';

const GH_BASE = 'https://onlinebooking.garagehive.co.uk/api/external-booking';

export type GhLocation = { id: number; name: string; address: string };

// The API key is identical across every GarageHive garage. Prefer an explicit env var; otherwise
// lift it from any garage already configured for GarageHive (that's where it lives today).
let cachedApiKey: string | null = null;
export const resolveSharedGhApiKey = async (): Promise<string | null> => {
  if (cachedApiKey) return cachedApiKey;
  const fromEnv = process.env.GARAGEHIVE_API_KEY || process.env.GH_API_KEY;
  if (fromEnv) {
    cachedApiKey = fromEnv;
    return cachedApiKey;
  }
  const existing = await prisma.agentConfiguration.findFirst({
    where: { integrationProvider: 'garage_hive' },
    select: { integrationProviderConfig: true },
  });
  const ipc = (existing?.integrationProviderConfig && typeof existing.integrationProviderConfig === 'object')
    ? (existing.integrationProviderConfig as Record<string, unknown>)
    : {};
  const key = (typeof ipc.apiKey === 'string' && ipc.apiKey)
    || (typeof ipc.ghApiKey === 'string' && ipc.ghApiKey)
    || null;
  cachedApiKey = key || null;
  return cachedApiKey;
};

// Call /init for an instance and return its location list. This both validates the instance
// (bad instance / bad key -> non-200) and yields the locations to match against. /init only
// starts a booking session — it writes nothing to the garage's diary.
export const ghInit = async (
  instance: string,
  apiKey: string,
): Promise<{ ok: boolean; status: number; locations: GhLocation[]; error?: string }> => {
  const url = `${GH_BASE}/${encodeURIComponent(instance)}/init`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!r.ok) {
      return { ok: false, status: r.status, locations: [], error: `init returned ${r.status}` };
    }
    const body = (await r.json()) as { locations?: unknown };
    const raw = Array.isArray(body.locations) ? body.locations : [];
    const locations: GhLocation[] = raw
      .map((l): GhLocation | null => {
        if (!l || typeof l !== 'object') return null;
        const o = l as Record<string, unknown>;
        if (typeof o.id !== 'number') return null;
        return { id: o.id, name: typeof o.name === 'string' ? o.name : '', address: typeof o.address === 'string' ? o.address : '' };
      })
      .filter((l): l is GhLocation => l !== null);
    return { ok: true, status: r.status, locations };
  } catch (e) {
    return { ok: false, status: 0, locations: [], error: e instanceof Error ? e.message : 'init failed' };
  }
};

// ---- Branch matching -------------------------------------------------------
// Match a garage to a location by distinctive tokens (town names, postcodes) shared between the
// garage's name+address and the location's name+address. Generic words are stripped so "In'n'out
// Autocentres Norwich" vs "Norwich - In N Out Autocentres" scores on "norwich", not the chain name.
const STOP = new Set([
  'the', 'and', 'ltd', 'limited', 'garage', 'garages', 'autocentre', 'autocentres', 'auto', 'centre',
  'centres', 'center', 'motors', 'motor', 'services', 'service', 'ltd.', 'co', 'company', 'in', 'n',
  'out', 'car', 'cars', 'vehicle', 'repairs', 'repair', 'performance', 'automotive', 'tyres', 'tyre',
]);
const POSTCODE_RE = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/gi;

const tokens = (s: string): Set<string> => {
  const set = new Set<string>();
  for (const w of (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)) {
    if (w && w.length >= 3 && !STOP.has(w)) set.add(w);
  }
  return set;
};
const postcodes = (s: string): Set<string> => {
  const set = new Set<string>();
  for (const m of (s || '').toUpperCase().matchAll(POSTCODE_RE)) set.add(m[0].replace(/\s+/g, ''));
  return set;
};

export type BranchMatch = {
  locationId: number | null;
  confidence: 'auto' | 'high' | 'low' | 'none';
  score: number;
  runnerUpScore: number;
};

// Score a garage against a location by asking: how many of the LOCATION's distinctive tokens
// (its town) appear in the garage? Dividing by the location's token count — not the garage's —
// keeps a long garage address from diluting the town signal. Matches in the garage NAME count
// full; address-only matches count less (a road named after another town is noise, not signal).
// A postcode match is decisive.
const scoreOne = (garageName: string, garageAddress: string, loc: GhLocation): number => {
  // The location's distinctive signal is the town in its NAME ("Basingstoke - In N Out
  // Autocentres"), not its street address — so score primarily on the location-name tokens.
  const lName = tokens(loc.name);
  if (lName.size === 0) return 0;
  const gName = tokens(garageName);
  const gAll = tokens(`${garageName} ${garageAddress}`);
  let hitInName = 0;
  let hitInAddr = 0;
  for (const t of lName) {
    if (gName.has(t)) hitInName += 1; // town in the garage NAME — strongest
    else if (gAll.has(t)) hitInAddr += 1; // only in the garage address — weaker
  }
  let score = (hitInName + hitInAddr * 0.5) / lName.size;
  // An exact postcode match (garage address vs location address) is decisive.
  const gP = postcodes(`${garageName} ${garageAddress}`);
  const lP = postcodes(`${loc.name} ${loc.address}`);
  for (const p of gP) if (lP.has(p)) score += 1;
  return score;
};

export const matchBranch = (garageName: string, garageAddress: string, locations: GhLocation[]): BranchMatch => {
  if (locations.length === 0) return { locationId: null, confidence: 'none', score: 0, runnerUpScore: 0 };
  if (locations.length === 1) return { locationId: locations[0].id, confidence: 'auto', score: 1, runnerUpScore: 0 };
  const scored = locations
    .map((l) => ({ id: l.id, s: scoreOne(garageName, garageAddress, l) }))
    .sort((a, b) => b.s - a.s);
  const [top, second] = scored;
  const runnerUp = second ? second.s : 0;
  // Confident when the best is a solid, clear win over the runner-up.
  const clear = top.s >= 0.5 && top.s - runnerUp >= 0.34;
  return {
    locationId: top.s > 0 ? top.id : null,
    confidence: clear ? 'high' : top.s > 0 ? 'low' : 'none',
    score: Number(top.s.toFixed(2)),
    runnerUpScore: Number(runnerUp.toFixed(2)),
  };
};
