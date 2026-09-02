// ---------------------------------------------------------------------------
// Garage Hive (Business Central) API client
// ---------------------------------------------------------------------------
// Garage Hive runs on Microsoft Dynamics 365 Business Central. Data is reached
// via the BC OData API using an Azure AD app (client-credentials flow):
//
//   1. POST login.microsoftonline.com/{tenantId}/oauth2/v2.0/token
//        scope = https://api.businesscentral.dynamics.com/.default
//   2. GET  api.businesscentral.dynamics.com/v2.0/{tenantId}/{environmentName}
//              /api/garageHive/{group}/v2.0/companies({companyId})/{entity}
//
// Production model: each Garage Hive account = its own BC environment (tenant +
// environmentName); branches within an account = companies. So per garage we
// need { tenantId, environmentName, companyId }. The Azure AD app credentials
// (clientId/secret) are shared across accounts once each account grants the app
// access. For the sandbox we read everything from env; per-garage creds live in
// the GarageHiveConnection table once garages are onboarded (see resolveCreds).
// ---------------------------------------------------------------------------

import axios from 'axios';
import { prisma } from '../db.js';
import { NAME_TITLES, usableFirstName } from '../utils/personName.js';

export { usableFirstName };

export interface GarageHiveCreds {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  environmentName: string;
  companyId: string;
}

/** A vehicle whose MOT or service falls due, joined to its owner's contact. */
export interface ReminderContact {
  customerName: string;
  phone: string;
  registration: string;
  motDueDate?: string;
  serviceDueDate?: string;
  /** Which due-date triggered this reminder — drives the message template. */
  dueType: 'mot' | 'service';
}

interface RawVehicle {
  id?: string;
  registrationNo: string;
  customerNo: string;
  makeCode?: string;
  modelDescription?: string;
  motDueDate?: string;
  serviceDueDate?: string;
  disableReminders?: boolean;
}

interface RawCustomer {
  number: string;
  displayName?: string;
  phoneNumber?: string;
  mobilePhoneNumber?: string;
  email?: string;
}

// A BC "empty date" comes back as 0001-01-01 rather than null.
const EMPTY_DATE = '0001-01-01';

// ---------------------------------------------------------------------------
// Credential resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the Garage Hive credentials for a garage. Prefers the per-garage
 * GarageHiveConnection row (tenantId + environmentName + companyId), falling
 * back to the shared Azure AD app clientId/secret from env when the row doesn't
 * carry its own. If no connection row exists, falls back entirely to env (the
 * sandbox / single-tenant setup).
 */
export async function resolveCreds(garageId?: string): Promise<GarageHiveCreds | null> {
  const envClientId = process.env.GARAGEHIVE_CLIENT_ID;
  const envClientSecret = process.env.GARAGEHIVE_CLIENT_SECRET;

  if (garageId) {
    const conn = await prisma.garageHiveConnection.findUnique({ where: { garageId } });
    if (conn) {
      const clientId = conn.clientId || envClientId;
      const clientSecret = conn.clientSecret || envClientSecret;
      if (clientId && clientSecret) {
        return {
          tenantId: conn.tenantId,
          environmentName: conn.environmentName,
          companyId: conn.companyId,
          clientId,
          clientSecret,
        };
      }
      return null;
    }
  }

  // Env fallback — sandbox / single shared environment.
  const tenantId = process.env.GARAGEHIVE_TENANT_ID;
  const environmentName = process.env.GARAGEHIVE_ENVIRONMENT;
  const companyId = process.env.GARAGEHIVE_COMPANY_ID;
  if (!tenantId || !envClientId || !envClientSecret || !environmentName || !companyId) {
    return null;
  }
  return { tenantId, clientId: envClientId, clientSecret: envClientSecret, environmentName, companyId };
}

// ---------------------------------------------------------------------------
// Auth (token cache keyed by tenant+client)
// ---------------------------------------------------------------------------

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function getToken(creds: GarageHiveCreds): Promise<string> {
  const key = `${creds.tenantId}:${creds.clientId}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }

  const body = new URLSearchParams({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    scope: 'https://api.businesscentral.dynamics.com/.default',
    grant_type: 'client_credentials',
  });

  const res = await axios.post(
    `https://login.microsoftonline.com/${creds.tenantId}/oauth2/v2.0/token`,
    body.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  );

  const token: string = res.data.access_token;
  const expiresIn: number = res.data.expires_in ?? 3600;
  tokenCache.set(key, { token, expiresAt: Date.now() + expiresIn * 1000 });
  return token;
}

function apiBase(creds: GarageHiveCreds): string {
  return (
    `https://api.businesscentral.dynamics.com/v2.0/${creds.tenantId}` +
    `/${creds.environmentName}/api/garageHive`
  );
}

async function get<T>(creds: GarageHiveCreds, url: string): Promise<T[]> {
  const token = await getToken(creds);
  const res = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
  return (res.data?.value ?? []) as T[];
}

// ---------------------------------------------------------------------------
// Connection test — validates the token AND that the assigned BC permission set
// actually exposes each Garage Hive API group. GETting a module's base URL
// returns its entity directory, so it works without a valid companyId. Powers
// the "Connect Garage Hive" admin check and one-off diagnostics.
// ---------------------------------------------------------------------------

export interface GhModuleResult {
  ok: boolean;
  status?: number;
  entityCount?: number;
  sample?: string[];
  error?: string;
}

export interface GhConnectionTest {
  ok: boolean;
  hasCreds: boolean;
  tenantId?: string;
  environmentName?: string;
  companyId?: string;
  tokenAcquired: boolean;
  modules: Record<string, GhModuleResult>;
}

function ghErrDetail(err: unknown): { status?: number; message: string } {
  const e = err as { response?: { status?: number; data?: { error?: { message?: string }; error_description?: string } }; message?: string };
  const status = e?.response?.status;
  const data = e?.response?.data;
  const raw = data?.error?.message || data?.error_description || e?.message || String(err);
  return { status, message: typeof raw === 'string' ? raw.split('\n')[0] : String(raw) };
}

/** Test modules: general (all plans), phoneIntegration (all plans), service (Garage Link Advanced). */
const TEST_MODULES = ['general/v2.0', 'phoneIntegration/v2.0', 'service/v2.0'];

export async function testConnection(garageId?: string): Promise<GhConnectionTest> {
  const creds = await resolveCreds(garageId);
  if (!creds) return { ok: false, hasCreds: false, tokenAcquired: false, modules: {} };

  const out: GhConnectionTest = {
    ok: false,
    hasCreds: true,
    tenantId: creds.tenantId,
    environmentName: creds.environmentName,
    companyId: creds.companyId,
    tokenAcquired: false,
    modules: {},
  };

  try {
    await getToken(creds);
    out.tokenAcquired = true;
  } catch (err) {
    const { status, message } = ghErrDetail(err);
    out.modules.token = { ok: false, status, error: message };
    return out;
  }

  for (const mod of TEST_MODULES) {
    try {
      const entities = await get<{ name?: string }>(creds, `${apiBase(creds)}/${mod}`);
      out.modules[mod] = {
        ok: true,
        entityCount: entities.length,
        sample: entities.map((e) => e.name || '').filter(Boolean).slice(0, 8),
      };
    } catch (err) {
      const { status, message } = ghErrDetail(err);
      out.modules[mod] = { ok: false, status, error: message };
    }
  }

  // "Working" = token + at least the always-available General API responding.
  out.ok = out.tokenAcquired && out.modules['general/v2.0']?.ok === true;
  return out;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** yyyy-mm-dd for a Date, in UTC (BC dates are date-only). */
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Vehicles whose MOT or service is due on an exact date. Run per-due-type
 * because BC OData rejects an OR across two ranges. disableReminders vehicles
 * are filtered server-side.
 */
async function vehiclesDueOn(
  creds: GarageHiveCreds,
  field: 'motDueDate' | 'serviceDueDate',
  date: string,
): Promise<RawVehicle[]> {
  const base = apiBase(creds);
  const company = `companies(${creds.companyId})`;
  const select =
    'registrationNo,customerNo,makeCode,modelDescription,motDueDate,serviceDueDate,disableReminders';
  const filter = encodeURIComponent(`${field} eq ${date} and disableReminders eq false`);
  const url = `${base}/general/v2.0/${company}/vehicles?$select=${select}&$filter=${filter}`;
  return get<RawVehicle>(creds, url);
}

function vehiclesUrl(creds: GarageHiveCreds): string {
  return `${apiBase(creds)}/general/v2.0/companies(${creds.companyId})/vehicles`;
}

/** Query vehicles by an OData filter. */
async function vehiclesByFilter(
  creds: GarageHiveCreds,
  filter: string,
  select: string,
): Promise<RawVehicle[]> {
  const url = `${vehiclesUrl(creds)}?$select=${select}&$filter=${encodeURIComponent(filter)}`;
  return get<RawVehicle>(creds, url);
}

/** Set fields on a single vehicle (PATCH). If-Match:* skips the etag check. */
async function patchVehicle(
  creds: GarageHiveCreds,
  vehicleId: string,
  data: Record<string, unknown>,
): Promise<void> {
  const token = await getToken(creds);
  await axios.patch(`${vehiclesUrl(creds)}(${vehicleId})`, data, {
    headers: { Authorization: `Bearer ${token}`, 'If-Match': '*', 'Content-Type': 'application/json' },
  });
}

/**
 * Opt a customer out of reminders in Garage Hive: set disableReminders=true on
 * every vehicle belonging to the owner of `registration`. Returns how many
 * vehicles were changed. Keeps Garage Hive as the source of truth so future
 * daily pulls exclude them at source.
 */
export interface BcCompany {
  id: string;
  name?: string;
  displayName?: string;
}

/**
 * The companies inside a Business Central environment — which, in Garage Hive's model, are the
 * branches of one account.
 *
 * Takes the tenant and environment directly rather than a garageId, because this runs BEFORE any
 * connection exists: it is what turns "here are our BC details" into a list you can point at a
 * garage. The Azure AD app credentials are ours and shared, so the only thing the garage has to
 * do on their side is grant that app access.
 */
export async function listCompanies(
  tenantId: string,
  environmentName: string,
): Promise<BcCompany[]> {
  const clientId = process.env.GARAGEHIVE_CLIENT_ID;
  const clientSecret = process.env.GARAGEHIVE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('The shared Garage Hive app credentials are not configured on this server');
  }
  const creds: GarageHiveCreds = {
    tenantId,
    environmentName,
    companyId: '',
    clientId,
    clientSecret,
  };
  return get<BcCompany>(creds, `${apiBase(creds)}/general/v2.0/companies`);
}

/**
 * Bring one call's caller name into line with the garage's phonebook.
 *
 * Fire and forget: call it as `void reconcileCallerName(...)` after the row is saved. Every exit
 * is a quiet no-op — no Garage Hive connection, no phone number, no phonebook match, or nothing
 * worth changing — because a wrong name is a small problem and a failed call save is a large one.
 *
 * Not matching is normal. A new customer has no phonebook entry, and their absence says nothing
 * about whether the name we heard is right, so we keep it exactly as the agent wrote it.
 */
export async function reconcileCallerName(
  garageId: string,
  callId: string,
  phone?: string | null,
  heardName?: string | null,
): Promise<void> {
  try {
    if (!phone) return;
    const creds = await resolveCreds(garageId);
    if (!creds) return;                       // garage not connected to Business Central

    const match = await lookupPhonebookByPhone(creds, phone);
    if (!match?.name) return;                 // not a customer of theirs — keep what we heard

    const merged = mergeCallerName(heardName, match.name);
    if (!merged) return;                      // ours is already as good or better

    await prisma.call.update({ where: { id: callId }, data: { customerName: merged } });
    console.log(
      `[GH_CALLER] ${callId}: name "${heardName || '(blank)'}" → "${merged}" from the phonebook`,
    );
  } catch (e) {
    console.error('[GH_CALLER] name reconcile failed (call record left as-is):', e);
  }
}

export async function disableRemindersForRegistration(
  creds: GarageHiveCreds,
  registration: string,
): Promise<number> {
  const reg = registration.trim().replace(/'/g, "''");
  const found = await vehiclesByFilter(
    creds,
    `registrationNo eq '${reg}'`,
    'id,registrationNo,customerNo,disableReminders',
  );
  if (found.length === 0) return 0;

  const target = found[0];
  const vehicles = target.customerNo
    ? await vehiclesByFilter(
        creds,
        `customerNo eq '${target.customerNo.replace(/'/g, "''")}'`,
        'id,registrationNo,disableReminders',
      )
    : found;

  let changed = 0;
  for (const v of vehicles) {
    if (v.id && !v.disableReminders) {
      await patchVehicle(creds, v.id, { disableReminders: true });
      changed++;
    }
  }
  return changed;
}

/**
 * Resolve a garage's creds and opt the customer out in Garage Hive. Safe to
 * call fire-and-forget — returns 0 (rather than throwing) when Garage Hive
 * isn't connected or no registration is known.
 */
export async function optOutFromReminders(garageId: string, registration?: string | null): Promise<number> {
  if (!registration) return 0;
  const creds = await resolveCreds(garageId);
  if (!creds) return 0;
  return disableRemindersForRegistration(creds, registration);
}

// ---------------------------------------------------------------------------
// Caller recognition — resolve an inbound phone number to a customer + vehicles
// ---------------------------------------------------------------------------

export interface CallerVehicle {
  registration: string;
  make?: string;
  model?: string;
  motDueDate?: string;
  serviceDueDate?: string;
}

/**
 * A first name the agent can safely say, or nothing.
 *
 * Garage phonebooks are typed by hand over years, so the name field holds whatever a receptionist
 * put there: "Mr", "Mrs J Smith", "SMITH, John", "j smith". Great Hollands' entries are mostly
 * bare titles. Returning those verbatim gets you "Hello Mr" on a real call, so anything that is
 * not clearly a given name returns undefined and the agent simply greets them without one.
 */
/** Levenshtein distance. Names are short, so the naive version is fine. */
function editDistance(a: string, b: string): number {
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Two spellings of one surname, or two different names?
 *
 * The edit-distance test catches a mishearing (Sanders/Saunders, Tideman/Tydeman). The prefix
 * test catches the ones distance cannot, where the garage holds a longer or hyphenated form:
 * "Turnow" against "Turner-Howe" is five edits apart but obviously the same family — and since
 * both records hang off the SAME phone number, the shared opening is strong evidence.
 */
function sameSurname(ours: string, theirs: string): boolean {
  if (!ours || !theirs) return false;
  const a = ours.replace(/[^a-z]/gi, '').toLowerCase();
  const b = theirs.replace(/[^a-z]/gi, '').toLowerCase();
  if (!a || !b) return false;
  if (a === b) return true;
  const longest = Math.max(a.length, b.length);
  if (editDistance(a, b) <= Math.max(2, Math.floor(longest * 0.34))) return true;
  return a.length >= 4 && b.length >= 4 && a.slice(0, 4) === b.slice(0, 4);
}

const nameWords = (raw?: string | null): string[] =>
  String(raw || '')
    .replace(/[^A-Za-z'\u2019-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !NAME_TITLES.has(w.toLowerCase()));

// Capitalises after hyphens and apostrophes too, so Turner-Howe and O'Brien survive being
// normalised out of whatever case the garage typed them in.
const titleCase = (w: string) =>
  w.toLowerCase().replace(/(^|[-'\u2019])([a-z])/g, (_m, sep, ch) => sep + ch.toUpperCase());

/**
 * The best version of a caller's name, or null to leave ours alone.
 *
 * Returns null rather than an identical string when nothing improves, so callers can tell "no
 * change needed" from "changed to the same thing" without comparing.
 */
export function mergeCallerName(ours?: string | null, theirs?: string | null): string | null {
  const o = nameWords(ours);
  const t = nameWords(theirs);
  const theirsDisplay = String(theirs || '').trim();

  // Nothing usable of theirs (a bare title, or a record whose "name" is a phone number): keep
  // ours. Checked FIRST, because when neither side has a real name the old order returned theirs
  // verbatim without comparing — so a record holding "07376146198" was rewritten to itself on
  // every run, and the backfill never converged.
  if (!t.length) return null;
  // Nothing of ours: take theirs as stored. "Mr Smith" is fine to SHOW in a list — it is only
  // bad to say out loud, which is usableFirstName's job, not this one.
  if (!o.length) return theirsDisplay && theirsDisplay !== String(ours || '').trim() ? theirsDisplay : null;

  // The two records already agree — nothing to merge, whatever shape the name is in.
  if (o.join(' ').toLowerCase() === t.join(' ').toLowerCase()) return null;

  const oSurname = o[o.length - 1];
  const tSurname = t[t.length - 1];

  // One word of ours: is it their first name or their surname? Either way theirs is fuller.
  if (o.length === 1) {
    const asFirst = t[0] && sameSurname(o[0], t[0]);
    const asLast = sameSurname(o[0], tSurname);
    if (!asFirst && !asLast) return null;             // unrelated to their record
    // Drop bare initials: "Crawford" plus their "N Crawford" is not an improvement, and it
    // oscillated — the next pass stripped the initial straight back off again.
    const meaningful = t.filter((w) => w.length > 1);
    const merged = (meaningful.length ? meaningful : t).map(titleCase).join(' ');
    return merged.toLowerCase() === o[0].toLowerCase() ? null : merged;
  }

  // Different surnames entirely — a partner, a driver, a trade account. Ours stands.
  if (!sameSurname(oSurname, tSurname)) return null;

  // Their first word only counts as a given name when a surname follows it; otherwise it IS the
  // surname and tells us nothing about who rang.
  const theirFirst = t.length >= 2 && t[0].length > 1 ? t[0] : '';
  const ourFirst = o[0].length > 1 ? o[0] : '';
  const first = ourFirst || theirFirst;
  const middles = o.slice(1, -1);                     // keep "Janet Irene Davies"

  // Spelling: theirs wins when it differs, since it is typed from paperwork rather than heard.
  const surname =
    oSurname.toLowerCase() === tSurname.toLowerCase() ? oSurname : tSurname;

  const merged = [first, ...middles, surname].filter(Boolean).map(titleCase).join(' ');
  const current = o.map(titleCase).join(' ');
  return merged && merged !== current ? merged : null;
}

export interface CallerProfile {
  matched: boolean;
  customerNo?: string;
  name?: string;
  /** Safe to greet with. Absent when the stored name is a title, an initial or a company. */
  firstName?: string;
  contactNo?: string;
  matchedField?: string;
  vehicles: CallerVehicle[];
}

interface RawPhonebook {
  contactNo?: string;
  customerNo?: string;
  name?: string;
  phoneNo?: string;
  phoneNo2?: string;
  mobilePhoneNo?: string;
  mobilePhoneNo2?: string;
}

/**
 * Generate the formats a UK number might be stored as in Garage Hive. The
 * phonebook matches exact strings and a garage may have typed the number any
 * number of ways, so we try E.164 (+44…), country-code (44…) and national (0…).
 */
export function phoneVariants(raw: string): string[] {
  const cleaned = raw.replace(/^whatsapp:/i, '').replace(/[\s\-().]/g, '');
  let nsn = ''; // national significant number, no country code, no leading 0
  if (cleaned.startsWith('+44')) nsn = cleaned.slice(3);
  else if (cleaned.startsWith('0044')) nsn = cleaned.slice(4);
  else if (cleaned.startsWith('44') && cleaned.length >= 12) nsn = cleaned.slice(2);
  else if (cleaned.startsWith('0')) nsn = cleaned.slice(1);
  else nsn = cleaned;

  const variants = new Set<string>();
  if (nsn) {
    variants.add(`+44${nsn}`);
    variants.add(`44${nsn}`);
    variants.add(`0${nsn}`);
  }
  if (cleaned) variants.add(cleaned);
  return [...variants];
}

/**
 * Look up a phone number in the Garage Hive CTI phonebook. Queries each of the
 * four phone fields (OR is allowed within one field, not across fields), trying
 * all likely stored formats. Returns the first match, or null.
 */
export async function lookupPhonebookByPhone(
  creds: GarageHiveCreds,
  phone: string,
): Promise<RawPhonebook | null> {
  const variants = phoneVariants(phone);
  if (variants.length === 0) return null;

  const base = apiBase(creds);
  const company = `companies(${creds.companyId})`;
  const select = 'contactNo,customerNo,name,phoneNo,phoneNo2,mobilePhoneNo,mobilePhoneNo2';

  for (const field of ['mobilePhoneNo', 'phoneNo', 'mobilePhoneNo2', 'phoneNo2']) {
    const clause = variants.map((v) => `${field} eq '${v.replace(/'/g, "''")}'`).join(' or ');
    const url = `${base}/phoneIntegration/v2.0/${company}/gH1PhonebookList?$select=${select}&$filter=${encodeURIComponent(clause)}`;
    const rows = await get<RawPhonebook>(creds, url);
    if (rows.length > 0) return { ...rows[0], phoneNo: rows[0].phoneNo }; // matched
  }
  return null;
}

/**
 * A canned caller profile for testing, used ONLY when Garage Hive is not connected.
 *
 * Two locks, both required:
 *   GARAGEHIVE_CALLER_FIXTURE=on          — off unless explicitly set
 *   GARAGEHIVE_FIXTURE_GARAGE_IDS=a,b,c   — allowlist; a customer garage can never match
 *
 * Returns null unless both hold, so the live path is untouched. The data is obviously fake on
 * purpose: if it ever escapes into a real call, "Fixture Test" is unmistakable.
 */
function fakeCallerProfile(garageId: string, phone: string): CallerProfile | null {
  if (String(process.env.GARAGEHIVE_CALLER_FIXTURE || '').toLowerCase() !== 'on') return null;
  const allowed = (process.env.GARAGEHIVE_FIXTURE_GARAGE_IDS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (!allowed.includes(garageId)) return null;

  // Optionally restrict to specific callers, so a stranger ringing the test line still hears the
  // unrecognised path — which is the more important behaviour to check.
  const numbers = (process.env.GARAGEHIVE_FIXTURE_PHONES || '')
    .split(',').map((s) => s.replace(/\D/g, '')).filter(Boolean);
  const digits = String(phone || '').replace(/\D/g, '');
  if (numbers.length && !numbers.some((n) => digits.endsWith(n.slice(-9)))) return null;

  return {
    matched: true,
    customerNo: 'FIXTURE-001',
    name: process.env.GARAGEHIVE_FIXTURE_NAME || 'Dan Fixture-Test',
    contactNo: 'C-FIXTURE',
    vehicles: [
      {
        registration: 'KX20HGF',
        make: 'Volkswagen',
        model: 'Golf',
        motDueDate: '2026-09-04',
        serviceDueDate: '2026-11-01',
      },
    ],
  };
}

/**
 * Resolve an inbound number to a caller profile: who they are + their vehicles
 * with MOT/service due dates. Read-only. Returns { matched:false } when unknown.
 */
export async function getCallerProfile(garageId: string, phone: string): Promise<CallerProfile> {
  // Off unless the garage has opted in (toggle lives on the agent config, in
  // Booking & Transfers) — keeps the agent inert by default.
  const cfg = await prisma.agentConfiguration.findUnique({
    where: { garageId },
    select: { callerRecognitionEnabled: true },
  });
  if (!cfg?.callerRecognitionEnabled) return { matched: false, vehicles: [] };

  const creds = await resolveCreds(garageId);
  if (!creds) {
    // No Business Central credentials. Normally that means "we cannot answer", and the
    // matched:false we return is indistinguishable from "not a customer" — which is precisely
    // why nobody noticed this endpoint had nothing behind it.
    //
    // The fixture below exists so caller recognition can be heard on a real call BEFORE Garage
    // Hive supply credentials. It is deliberately hard to switch on by accident: it needs an
    // env flag AND the garage must be on the allowlist, which holds test accounts only. Without
    // both, behaviour is exactly as before.
    const fixture = fakeCallerProfile(garageId, phone);
    if (fixture) {
      console.log(`[GH] caller fixture served for ${garageId} (${phone}) — NOT real Garage Hive data`);
      return fixture;
    }
    return { matched: false, vehicles: [] };
  }

  const match = await lookupPhonebookByPhone(creds, phone);
  if (!match?.customerNo) return { matched: false, vehicles: [] };

  const vehicles = await vehiclesByFilter(
    creds,
    `customerNo eq '${match.customerNo.replace(/'/g, "''")}'`,
    'registrationNo,makeCode,modelDescription,motDueDate,serviceDueDate',
  );

  const clean = (d?: string) => (d && d !== EMPTY_DATE ? d : undefined);
  const firstName = usableFirstName(match.name);
  console.log(
    `[GH_CALLER] ${garageId} matched customerNo=${match.customerNo}` +
      ` name=${match.name ? 'set' : 'none'} greetable=${firstName ? 'yes' : 'no'}` +
      ` vehicles=${vehicles.length}`,
  );

  return {
    matched: true,
    customerNo: match.customerNo,
    name: match.name,
    firstName,
    contactNo: match.contactNo,
    vehicles: vehicles.map((v) => ({
      registration: v.registrationNo,
      make: v.makeCode || undefined,
      model: v.modelDescription || undefined,
      motDueDate: clean(v.motDueDate),
      serviceDueDate: clean(v.serviceDueDate),
    })),
  };
}

// ---------------------------------------------------------------------------
// Advisory upsells — outstanding vehicle-health-check advisories for a vehicle
// ---------------------------------------------------------------------------

export interface AdvisoryItem {
  description: string;
  price?: number;
  estimateNo?: string;
  date?: string;
  status?: string;
}

interface RawVIE {
  number?: string;
  vehicleRegistrationNo?: string;
  status?: string;
  vieStatus?: string;
  documentDate?: string;
  amountIncludingVAT?: number;
}

interface RawVIELine {
  documentNo?: string;
  lineType?: string;
  description?: string;
  quantity?: number;
  unitPrice?: number;
  lineAmount?: number;
  amountIncludingVAT?: number;
}

// NOTE: the exact status values Garage Hive uses for "advised but not yet booked"
// vs "converted to a job / done" must be validated against a real garage's data
// (the sandbox has no VHC records). Until then keep the garage toggle OFF. We
// conservatively DROP anything that looks already-actioned.
const CLOSED_VIE_STATUS = /(convert|complete|closed|done|invoiced|cancel)/i;

async function serviceQuery<T>(creds: GarageHiveCreds, entity: string, query: string): Promise<T[]> {
  const url = `${apiBase(creds)}/service/v2.0/companies(${creds.companyId})/${entity}?${query}`;
  return get<T>(creds, url);
}

/**
 * Outstanding advisory line-items for a vehicle, for the voice agent to offer at
 * booking time. Returns { enabled:false } when the garage toggle is off (so the
 * switch is enforced server-side and the agent simply gets nothing).
 */
export async function getVehicleAdvisories(
  garageId: string,
  registration: string,
): Promise<{ enabled: boolean; advisories: AdvisoryItem[] }> {
  const cfg = await prisma.agentConfiguration.findUnique({
    where: { garageId },
    select: { advisoryUpsellsEnabled: true },
  });
  if (!cfg?.advisoryUpsellsEnabled) return { enabled: false, advisories: [] };

  const creds = await resolveCreds(garageId);
  if (!creds || !registration) return { enabled: true, advisories: [] };

  const reg = registration.trim().replace(/'/g, "''");
  const estimates = await serviceQuery<RawVIE>(
    creds,
    'vehicleInspectionEstimates',
    `$select=number,vehicleRegistrationNo,status,vieStatus,documentDate,amountIncludingVAT` +
      `&$filter=${encodeURIComponent(`vehicleRegistrationNo eq '${reg}'`)}&$orderby=documentDate desc&$top=20`,
  );

  const open = estimates.filter(
    (e) => !CLOSED_VIE_STATUS.test(`${e.status || ''} ${e.vieStatus || ''}`),
  );

  const advisories: AdvisoryItem[] = [];
  for (const est of open) {
    if (!est.number) continue;
    const lines = await serviceQuery<RawVIELine>(
      creds,
      'vehicleInspectionEstimateLines',
      `$select=documentNo,lineType,description,quantity,unitPrice,lineAmount,amountIncludingVAT` +
        `&$filter=${encodeURIComponent(`documentNo eq '${est.number.replace(/'/g, "''")}'`)}`,
    );
    for (const ln of lines) {
      const desc = (ln.description || '').trim();
      // Skip heading/comment lines (no description or no chargeable amount).
      const amount = ln.amountIncludingVAT ?? ln.lineAmount;
      if (!desc || !amount) continue;
      advisories.push({
        description: desc,
        price: typeof amount === 'number' ? amount : undefined,
        estimateNo: est.number,
        date: est.documentDate && est.documentDate !== EMPTY_DATE ? est.documentDate : undefined,
        status: est.status || est.vieStatus || undefined,
      });
    }
  }
  return { enabled: true, advisories };
}

/** Look up a single customer by their Garage Hive customer number. */
async function getCustomer(creds: GarageHiveCreds, customerNo: string): Promise<RawCustomer | null> {
  const base = apiBase(creds);
  const company = `companies(${creds.companyId})`;
  const select = 'number,displayName,phoneNumber,mobilePhoneNumber,email';
  const filter = encodeURIComponent(`number eq '${customerNo.replace(/'/g, "''")}'`);
  const url = `${base}/general/v2.0/${company}/customers?$select=${select}&$filter=${filter}`;
  const rows = await get<RawCustomer>(creds, url);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Public: build reminder contacts for "due in N days"
// ---------------------------------------------------------------------------

/**
 * Pull vehicles whose MOT/service falls due exactly `daysAhead` days from now,
 * resolve each owner's contact number, and return them in the shape the
 * outbound-campaign pipeline expects. Runs daily so each vehicle is caught once
 * as it crosses the N-days-out mark.
 *
 * `now` is injectable for testing.
 */
export async function getReminderContacts(
  creds: GarageHiveCreds,
  daysAhead = 30,
  now: Date = new Date(),
): Promise<{ contacts: ReminderContact[]; skipped: { reg: string; reason: string }[] }> {
  const target = new Date(now);
  target.setUTCDate(target.getUTCDate() + daysAhead);
  const targetDate = isoDate(target);

  const [motDue, serviceDue] = await Promise.all([
    vehiclesDueOn(creds, 'motDueDate', targetDate),
    vehiclesDueOn(creds, 'serviceDueDate', targetDate),
  ]);

  const tagged: Array<{ v: RawVehicle; dueType: 'mot' | 'service' }> = [
    ...motDue.map((v) => ({ v, dueType: 'mot' as const })),
    ...serviceDue.map((v) => ({ v, dueType: 'service' as const })),
  ];

  const contacts: ReminderContact[] = [];
  const skipped: { reg: string; reason: string }[] = [];

  // Cache customer lookups within a run (one owner can have several vehicles).
  const customerCache = new Map<string, RawCustomer | null>();

  for (const { v, dueType } of tagged) {
    const reg = v.registrationNo || '(unknown)';
    if (!v.customerNo) {
      skipped.push({ reg, reason: 'no customer linked' });
      continue;
    }

    let customer = customerCache.get(v.customerNo);
    if (customer === undefined) {
      customer = await getCustomer(creds, v.customerNo);
      customerCache.set(v.customerNo, customer);
    }
    if (!customer) {
      skipped.push({ reg, reason: `customer ${v.customerNo} not found` });
      continue;
    }

    const phone = customer.mobilePhoneNumber || customer.phoneNumber || '';
    if (!phone) {
      skipped.push({ reg, reason: `customer ${v.customerNo} has no phone` });
      continue;
    }

    const contact: ReminderContact = {
      customerName: customer.displayName || 'Customer',
      phone,
      registration: reg,
      dueType,
    };
    if (dueType === 'mot' && v.motDueDate && v.motDueDate !== EMPTY_DATE) {
      contact.motDueDate = v.motDueDate;
    }
    if (dueType === 'service' && v.serviceDueDate && v.serviceDueDate !== EMPTY_DATE) {
      contact.serviceDueDate = v.serviceDueDate;
    }
    contacts.push(contact);
  }

  return { contacts, skipped };
}
