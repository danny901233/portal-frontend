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

export interface CallerProfile {
  matched: boolean;
  customerNo?: string;
  name?: string;
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
 * Resolve an inbound number to a caller profile: who they are + their vehicles
 * with MOT/service due dates. Read-only. Returns { matched:false } when unknown.
 */
export async function getCallerProfile(garageId: string, phone: string): Promise<CallerProfile> {
  // Off unless the garage has opted in — keeps the agent inert by default.
  const conn = await prisma.garageHiveConnection.findUnique({ where: { garageId } });
  if (!conn?.callerRecognitionEnabled) return { matched: false, vehicles: [] };

  const creds = await resolveCreds(garageId);
  if (!creds) return { matched: false, vehicles: [] };

  const match = await lookupPhonebookByPhone(creds, phone);
  if (!match?.customerNo) return { matched: false, vehicles: [] };

  const vehicles = await vehiclesByFilter(
    creds,
    `customerNo eq '${match.customerNo.replace(/'/g, "''")}'`,
    'registrationNo,makeCode,modelDescription,motDueDate,serviceDueDate',
  );

  const clean = (d?: string) => (d && d !== EMPTY_DATE ? d : undefined);
  return {
    matched: true,
    customerNo: match.customerNo,
    name: match.name,
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
  const conn = await prisma.garageHiveConnection.findUnique({ where: { garageId } });
  if (!conn?.advisoryUpsellsEnabled) return { enabled: false, advisories: [] };

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
