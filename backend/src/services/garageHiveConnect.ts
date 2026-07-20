// GarageHive "connect the diary" flow.
//
// GarageHive gives us one thing: the online-booking INSTANCE (customerId, e.g. "inoplus").
// The API key is shared across all GarageHive garages, so we already hold it. The location id
// is NOT supplied — it's derived by calling the online-booking /init endpoint, which returns the
// instance's location(s). For a single-branch instance that's one location; for a multi-branch
// instance (e.g. In'n'out under "inoplus") it returns them all, and we pick the right branch for
// each Garage record by matching the garage's own name/address — because WE know which branch we
// onboarded (from the agreement + garage records) and GarageHive does not.
import { createHmac, timingSafeEqual } from 'crypto';
import { prisma } from '../db.js';
import { sendAgentConfigWebhook } from '../routes/config.js';
import { sendEmail, brandedEmailShell } from '../utils/email.js';

const GH_BASE = 'https://onlinebooking.garagehive.co.uk/api/external-booking';
const PORTAL_URL = (process.env.PORTAL_URL || 'https://portal.receptionmate.co.uk').replace(/\/$/, '');
// GarageHive's own guide for adding the "Other" service package the agent needs to book custom jobs.
const GH_OTHER_GUIDE_URL = 'https://garagehive-co.slite.com/app/docs/YzHdXMeW8CwmE3/How-to-Set-Up-an-Other-Service-Package-for-Custom-Online-Bookings';

// ---- Stateless connect-link token (no DB row / migration) ------------------
// A signed { businessId, exp } — the emailed link carries this so GarageHive can open the form
// without a login. HMAC over JWT_SECRET; single-use isn't enforced because re-submitting the same
// instance is idempotent (it re-derives and re-writes the same config).
const TOKEN_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const signConnectToken = (businessId: string): string => {
  const secret = process.env.JWT_SECRET || '';
  const payload = Buffer.from(JSON.stringify({ b: businessId, exp: Date.now() + TOKEN_TTL_MS })).toString('base64url');
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
};
export const verifyConnectToken = (token: string): string | null => {
  const secret = process.env.JWT_SECRET || '';
  const [payload, sig] = (token || '').split('.');
  if (!payload || !sig) return null;
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  try {
    const a = Buffer.from(sig, 'base64url');
    const b = Buffer.from(expected, 'base64url');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const { b: businessId, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof businessId !== 'string' || typeof exp !== 'number' || Date.now() > exp) return null;
    return businessId;
  } catch {
    return null;
  }
};

// "Uses GarageHive" = at least one branch runs the GarageHive/v3 agent (selected at signup).
export const businessUsesGarageHive = async (businessId: string): Promise<boolean> => {
  const garages = await prisma.garage.findMany({ where: { businessId }, select: { id: true } });
  if (!garages.length) return false;
  const hit = await prisma.agentConfiguration.findFirst({
    where: { garageId: { in: garages.map((g) => g.id) }, agentScript: 'receptionmate-agent-v3' },
    select: { garageId: true },
  });
  return !!hit;
};

// Write one branch's GarageHive config and push it to the agent (DynamoDB).
const connectGarageToLocation = async (garageId: string, instance: string, apiKey: string, locationId: string) => {
  const garage = await prisma.garage.findUnique({
    where: { id: garageId },
    select: { name: true, agentConfiguration: { select: { integrationProviderConfig: true } } },
  });
  if (!garage) throw new Error('garage not found');
  const existing = (garage.agentConfiguration?.integrationProviderConfig && typeof garage.agentConfiguration.integrationProviderConfig === 'object')
    ? (garage.agentConfiguration.integrationProviderConfig as Record<string, unknown>)
    : {};
  const integrationProviderConfig = { ...existing, apiKey, customerId: instance, locationId };
  await prisma.agentConfiguration.upsert({
    where: { garageId },
    update: { integrationProvider: 'garage_hive', integrationProviderConfig, agentType: 'automate', agentScript: 'receptionmate-agent-v3' },
    create: { garageId, branchName: garage.name, integrationProvider: 'garage_hive', integrationProviderConfig, agentType: 'automate', agentScript: 'receptionmate-agent-v3' },
  });
  await sendAgentConfigWebhook(garageId);
};

// Place a marked test booking to PROVE the diary connection works end-to-end (not just that the
// credentials were accepted). Reg V20ALA, the first bookable service, the first available slot, and
// a "please cancel" note. Mirrors the voice agent's proven set-contact-info payload (salutation/
// last_name/city are required by GarageHive even though contact_info_fields doesn't list them).
export const placeTestBooking = async (
  instance: string,
  apiKey: string,
  locationId: number,
): Promise<{ ok: boolean; bookingId?: number; service?: string; when?: string; error?: string }> => {
  const H = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  const base = `${GH_BASE}/${encodeURIComponent(instance)}`;
  const post = async (path: string, body: unknown) => {
    const r = await fetch(`${base}/${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) });
    return { status: r.status, data: (await r.json().catch(() => null)) as any };
  };
  const get = async (path: string) => {
    const r = await fetch(`${base}/${path}`, { headers: H });
    return { status: r.status, data: (await r.json().catch(() => null)) as any };
  };
  try {
    const init = await post('init', { locationId });
    const sid = init.data?.booking?.session_id || init.data?.session_id;
    if (!sid) return { ok: false, error: 'init returned no session' };
    await post(`${sid}/set-vehicle-info`, { registration_no: 'V20ALA', reg_no_country: 'GB', location_id: locationId });
    const svc = await get(`${sid}/list-services`);
    const first = svc.data?.services?.[0];
    if (!first?.service_price_id) return { ok: false, error: 'no bookable services returned' };
    await post(`${sid}/set-services`, { servicePriceIDs: [first.service_price_id] });
    const ts = await get(`${sid}/list-timeslots`);
    const slots = (ts.data?.timeslots && typeof ts.data.timeslots === 'object') ? ts.data.timeslots : {};
    const date = Object.keys(slots)[0];
    const time = date ? slots[date]?.[0] : undefined;
    if (!date || !time) return { ok: false, error: 'no timeslots available' };
    await post(`${sid}/set-timeslot`, { bookingDate: date, bookingTime: time });
    const fin = await post(`${sid}/set-contact-info`, {
      contact_salutation: 10,
      contact_name: 'ReceptionMate',
      contact_last_name: 'Test',
      contact_number: '01234567890',
      contact_address: 'ReceptionMate test',
      contact_address2: '',
      contact_city: 'Test',
      contact_postcode: 'SW1A 1AA',
      vehicle_mileage: 10000,
      notes: 'receptionmate test booking please cancel',
    });
    if (fin.status < 200 || fin.status >= 300) {
      return { ok: false, error: `finalise HTTP ${fin.status}: ${JSON.stringify(fin.data).slice(0, 200)}` };
    }
    return { ok: true, bookingId: fin.data?.booking?.id, service: first.name, when: `${date} ${time}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'test booking failed' };
  }
};

// Getting-ready heads-up: sent to the garage when they SIGN (the earliest reliable touchpoint),
// so they have time to set up the GarageHive "Other" service package before they go live. Only
// while still waiting to connect — once connected they're going live and the "You're live" email
// carries the same instruction. Idempotent via a gettingReadyEmailedAt flag in the config JSON.
export const sendGarageHiveGettingReady = async (garageId: string): Promise<boolean> => {
  const garage = await prisma.garage.findUnique({
    where: { id: garageId },
    select: { id: true, name: true, agentConfiguration: { select: { integrationProviderConfig: true, agentScript: true } } },
  });
  if (!garage || garage.agentConfiguration?.agentScript !== 'receptionmate-agent-v3') return false; // not a GarageHive garage
  const ipc = (garage.agentConfiguration?.integrationProviderConfig && typeof garage.agentConfiguration.integrationProviderConfig === 'object')
    ? (garage.agentConfiguration.integrationProviderConfig as Record<string, unknown>)
    : {};
  if (ipc.customerId) return false; // already connected — the "You're live" email covers it
  if (ipc.gettingReadyEmailedAt) return false; // once only

  const users = await prisma.user.findMany({
    where: { garageAccessIds: { has: garageId }, role: { not: 'RECEPTIONMATE_STAFF' } },
    select: { email: true, branchRoles: true },
  });
  const manager = users.find((u) => (u.branchRoles as Record<string, string> | null)?.[garageId] === 'MANAGER') || users[0];
  if (!manager?.email) return false;

  await prisma.agentConfiguration.update({ where: { garageId }, data: { integrationProviderConfig: { ...ipc, gettingReadyEmailedAt: new Date().toISOString() } } });
  const body =
    `<tr><td style="padding: 32px;">` +
    `<h1 style="margin:0 0 14px;font-size:20px;color:#0f172a;font-weight:700;">Getting ${garage.name} ready</h1>` +
    `<p style="margin:0 0 12px;font-size:15px;line-height:1.55;color:#475569;">Thanks for signing. Your ReceptionMate agent books straight into your <strong>existing Garage Hive online booking system</strong> — nothing new to learn, and your diary stays exactly as it is.</p>` +
    `<p style="margin:0 0 12px;font-size:15px;line-height:1.55;color:#475569;">One thing to set up in Garage Hive while we finish your agent: add an <strong>“Other”</strong> service package, so the agent can book custom jobs that don't match a standard service. Garage Hive's guide walks you through it — <a href="${GH_OTHER_GUIDE_URL}" style="color:#3426cf;font-weight:600;">How to set up an “Other” service package</a>.</p>` +
    `<p style="margin:0;font-size:15px;line-height:1.55;color:#475569;">Do this whenever suits — we'll email you again the moment your agent is live.</p>` +
    `</td></tr>`;
  void sendEmail({
    to: [manager.email],
    subject: `Getting ${garage.name} ready on ReceptionMate`,
    text:
      `Thanks for signing. Your ReceptionMate agent books straight into your existing Garage Hive online booking system.\n\n` +
      `One thing to set up in Garage Hive while we finish your agent: add an "Other" service package so the agent can book custom jobs. ` +
      `Garage Hive's guide: ${GH_OTHER_GUIDE_URL}\n\nDo this whenever suits — we'll email you again the moment your agent is live.`,
    html: brandedEmailShell(body),
  });
  return true;
};

// Auto go-live convergence: a GarageHive garage is "live" once BOTH tracks are done — the
// agreement is signed AND the diary is connected. Whichever finishes last calls this; the first
// time both are true we email the garage "you're live" and mark them live. Idempotent via a
// goLiveEmailedAt flag stored in the config JSON (no migration, no agent resync needed).
export const announceGoLiveIfReady = async (garageId: string): Promise<boolean> => {
  const garage = await prisma.garage.findUnique({
    where: { id: garageId },
    select: { id: true, name: true, businessId: true, twilioNumber: true, agentConfiguration: { select: { integrationProviderConfig: true, agentScript: true } } },
  });
  if (!garage) return false;
  const ipc = (garage.agentConfiguration?.integrationProviderConfig && typeof garage.agentConfiguration.integrationProviderConfig === 'object')
    ? (garage.agentConfiguration.integrationProviderConfig as Record<string, unknown>)
    : {};
  const connected = !!ipc.customerId && !!ipc.locationId && garage.agentConfiguration?.agentScript === 'receptionmate-agent-v3';
  if (!connected || ipc.goLiveEmailedAt) return false;
  const signed = garage.businessId
    ? await prisma.agreement.findFirst({ where: { businessId: garage.businessId, status: { in: ['signed', 'externally_signed'] } }, select: { id: true } })
    : null;
  if (!signed) return false;

  // Mark announced (JSON flag only — the agent doesn't need it, so no DynamoDB resync) + go live.
  await prisma.agentConfiguration.update({ where: { garageId }, data: { integrationProviderConfig: { ...ipc, goLiveEmailedAt: new Date().toISOString() } } });
  await prisma.garage.update({ where: { id: garageId }, data: { onboardingStage: 'live' } }).catch(() => {});

  const users = await prisma.user.findMany({
    where: { garageAccessIds: { has: garageId }, role: { not: 'RECEPTIONMATE_STAFF' } },
    select: { email: true, branchRoles: true },
  });
  const manager = users.find((u) => (u.branchRoles as Record<string, string> | null)?.[garageId] === 'MANAGER') || users[0];
  if (manager?.email) {
    const number = garage.twilioNumber || 'your ReceptionMate number';
    const body =
      `<tr><td style="padding: 32px;">` +
      `<h1 style="margin:0 0 14px;font-size:20px;color:#0f172a;font-weight:700;">You're live 🎉</h1>` +
      `<p style="margin:0 0 12px;font-size:15px;line-height:1.55;color:#475569;"><strong>${garage.name}</strong> is now connected to your GarageHive diary.</p>` +
      `<p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#475569;">Your agent is live and ready to be connected to your phone system. If you haven't already, please <a href="${PORTAL_URL}" style="color:#3426cf;font-weight:600;">log in to the portal</a> to customise your agent, then set up call forwarding on your line to your ReceptionMate number:</p>` +
      `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 auto 18px;"><tr><td style="background:#f1f2f9;border-radius:10px;padding:14px 26px;text-align:center;"><span style="font-size:22px;font-weight:800;color:#3426cf;letter-spacing:0.5px;">${number}</span></td></tr></table>` +
      `<p style="margin:0;font-size:15px;line-height:1.55;color:#475569;">One last thing in Garage Hive: add an <strong>“Other”</strong> service package so the agent can book custom jobs. Garage Hive's guide walks you through it — <a href="${GH_OTHER_GUIDE_URL}" style="color:#3426cf;font-weight:600;">How to set up an “Other” service package</a>.</p>` +
      `</td></tr>`;
    void sendEmail({
      to: [manager.email],
      subject: `${garage.name} is live on ReceptionMate`,
      text:
        `${garage.name} is now connected to your GarageHive diary.\n\n` +
        `Your agent is live and ready to be connected to your phone system. If you haven't already, ` +
        `log in to the portal (${PORTAL_URL}) to customise your agent, then set up call forwarding on ` +
        `your line to your ReceptionMate number: ${number}.\n\n` +
        `One last thing in Garage Hive: add an "Other" service package so the agent can book custom jobs. ` +
        `Garage Hive's guide walks you through it: ${GH_OTHER_GUIDE_URL}`,
      html: brandedEmailShell(body),
    });
  }
  return true;
};

// The public flow's workhorse: instance in → auto-match every branch → connect the confident ones,
// flag the ambiguous ones for a human. GarageHive never picks a branch.
export const autoConnectBusiness = async (
  businessId: string,
  instance: string,
): Promise<{ ok: boolean; error?: string; instance: string;
  connected: Array<{ garageId: string; garageName: string; locationId: string; testBooking?: { ok: boolean; bookingId?: number; service?: string; when?: string; error?: string } }>;
  flagged: Array<{ garageId: string; garageName: string; matchedLocationId: number | null; confidence: string }>; }> => {
  const apiKey = await resolveSharedGhApiKey();
  if (!apiKey) return { ok: false, error: 'No shared GarageHive API key', instance, connected: [], flagged: [] };
  const garages = await prisma.garage.findMany({
    where: { businessId },
    select: { id: true, name: true, agentConfiguration: { select: { branchAddress: true } } },
    orderBy: { name: 'asc' },
  });
  if (!garages.length) return { ok: false, error: 'No garages for this business', instance, connected: [], flagged: [] };
  const init = await ghInit(instance, apiKey);
  if (!init.ok) return { ok: false, error: `GarageHive did not accept instance "${instance}"`, instance, connected: [], flagged: [] };

  const connected: Array<{ garageId: string; garageName: string; locationId: string; testBooking?: { ok: boolean; bookingId?: number; service?: string; when?: string; error?: string } }> = [];
  const flagged: Array<{ garageId: string; garageName: string; matchedLocationId: number | null; confidence: string }> = [];
  for (const g of garages) {
    const m = matchBranch(g.name, g.agentConfiguration?.branchAddress || '', init.locations);
    if (m.locationId != null && (m.confidence === 'auto' || m.confidence === 'high')) {
      await connectGarageToLocation(g.id, instance, apiKey, String(m.locationId));
      // Prove the diary works: place a marked test booking into this branch's location.
      const testBooking = await placeTestBooking(instance, apiKey, m.locationId);
      connected.push({ garageId: g.id, garageName: g.name, locationId: String(m.locationId), testBooking });
      // If they've already signed, this was the last piece — go live + email the garage.
      await announceGoLiveIfReady(g.id).catch(() => {});
    } else {
      flagged.push({ garageId: g.id, garageName: g.name, matchedLocationId: m.locationId, confidence: m.confidence });
    }
  }
  return { ok: true, instance, connected, flagged };
};

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
