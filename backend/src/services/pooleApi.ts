/**
 * Poole Software / AutoSage API client — pure HTTP wrapper, no LLM.
 *
 * Twelve typed helpers matching the 12 endpoints in the Poole handover doc
 * (sections A1-A2, B1-B6, C1-C3, D1). Talks to a per-branch REST API scoped
 * by an API key that Poole issues per branch.
 *
 * Key differences from bookarClient.ts:
 *   - Auth is a single `Key: {apiKey}` header — NOT OAuth2, NOT Bearer.
 *   - One key per branch (already scoped) — no separate client-id/secret pair.
 *   - Stateless / no token cache needed.
 *   - Draft bookings expire after 4h — the caller (chat agent) is responsible
 *     for not stashing drafts past that window.
 *   - Idempotency is baked into B1 via `callReference` (dedupe key), not a
 *     header — so no Idempotency-Key needed on POSTs.
 *   - Slot times are `HH:mm` (no seconds); dates are `yyyy-MM-dd`; both in
 *     local Europe/London wall-clock — NO UTC offsets.
 *
 * Errors: every non-2xx surface as a `PooleError` (or `PooleAuthError` for
 * 401) with status + body attached so the caller can branch on the code.
 * 429 rate-limit responses include `Retry-After` (seconds); we log it and
 * let the caller decide whether to retry — this module does NOT auto-retry.
 */
import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';

// ── Env ───────────────────────────────────────────────────────────────────
// Fallback to the sandbox URL from the handover doc; production URL will be
// swapped in via POOLE_API_BASE_URL once Poole issues it.
const SANDBOX_BASE_URL =
  'https://autosage-alpha-e6cucycjezh4guay.uksouth-01.azurewebsites.net';
const DEFAULT_TIMEOUT_MS = 15_000;

// ── Types (matching the JSON schemas in section 4 of the handover doc) ────

/** A1 · GET /inbound/customers?phone={number} — customer record with linked vehicles. */
export interface PooleVehicleSummary {
  registration: string;
  make?: string | null;
  model?: string | null;
}

export interface PooleCustomer {
  customerId: number;
  name?: string | null;          // e.g. "Mr Andrei Bazanov"
  organisation?: string | null;
  telephone?: string | null;
  mobile?: string | null;
  email?: string | null;
  vehicles?: PooleVehicleSummary[];
}

/** A2 · GET /inbound/vehicles/{registration} — vehicle detail + MOT. */
export interface PooleVehicle {
  registration: string;
  make?: string | null;
  model?: string | null;
  colour?: string | null;
  mileage?: number | null;
  motDueDate?: string | null;    // yyyy-MM-dd
  customerName?: string | null;
  source?: string | null;        // e.g. "File"
}

/** B2 · GET /inbound/bookings/{bookingRef}/services — services + prices. */
export interface PooleService {
  serviceId: number;
  code: string;
  description?: string | null;
  price: number;                 // GBP, matrix-priced per branch
  durationMinutes: number;
}

/** B4 · GET /inbound/bookings/{bookingRef}/slots — day-grouped slot windows. */
export interface PooleSlotDay {
  date: string;                  // yyyy-MM-dd
  times: string[];               // ["08:00", "08:30", ...]  HH:mm 24h
}

/** B6 · POST /inbound/bookings/{bookingRef}/confirm — customer input shape. */
export interface PooleConfirmCustomer {
  title?: string | null;
  firstName?: string | null;
  lastName: string;              // REQUIRED per handover doc
  organisation?: string | null;
  telephone?: string | null;
  mobile?: string | null;
  email?: string | null;
}

/** B6 · confirm — vehicle input shape. `registration` is REQUIRED. */
export interface PooleConfirmVehicle {
  registration: string;
  make?: string | null;
  model?: string | null;
}

/** B6 / C3 response — full booking detail. */
export interface PooleBookingDetail {
  bookingRef: string;
  reference: number;             // human-readable job number to quote to caller
  status: 'Pending' | 'Booked' | 'Cancelled' | string;
  branchName?: string | null;
  date?: string | null;          // yyyy-MM-dd
  time?: string | null;          // HH:mm
  endTime?: string | null;       // HH:mm
  registration?: string | null;
  customerName?: string | null;
  total?: number | null;
  services?: PooleService[];
}

/** D1 · GET /inbound/branches — branch info + opening hours. */
export interface PooleBranch {
  branchId: string;
  code: string;
  name: string;
  opensAt?: string | null;       // HH:mm
  closesAt?: string | null;      // HH:mm
  closedDays?: string[];         // e.g. ["Sunday"]
}

// ── Errors ────────────────────────────────────────────────────────────────

export class PooleError extends Error {
  status: number;
  body?: unknown;
  retryAfterSeconds?: number;    // populated on 429
  constructor(
    message: string,
    opts: { status?: number; body?: unknown; retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = 'PooleError';
    this.status = opts.status ?? 0;
    this.body = opts.body;
    this.retryAfterSeconds = opts.retryAfterSeconds;
  }
}

export class PooleAuthError extends PooleError {
  constructor(message: string, opts: { status?: number; body?: unknown } = {}) {
    super(message, opts);
    this.name = 'PooleAuthError';
  }
}

// ── Client factory ────────────────────────────────────────────────────────
//
// Per-call helpers rather than a class instance — matches the pattern the
// handover doc encourages ("branchKey scopes everything") and lets a single
// Node process serve many garages without needing to construct/cache a
// per-garage client. axios instances are cheap to create; no token to cache.

function getBaseUrl(): string {
  const raw = (process.env.POOLE_API_BASE_URL || '').trim();
  return (raw || SANDBOX_BASE_URL).replace(/\/+$/, '');
}

/**
 * Every request needs BOTH a per-branch Key and a per-tenant Tenant header on
 * the multi-tenant prod backend (`alpha.autosage.co.uk`). This wasn't in the
 * original handover doc — Yochanan confirmed 2026-08-28 that prod requires
 * `Tenant: <slug>` alongside `Key`. The sandbox we tested against on 2026-08-10
 * didn't need it because it was a single-tenant host; the current shared
 * prod backend won't route the request without it.
 *
 * Passing an empty string for tenant is allowed for the single-tenant sandbox
 * case — the header is omitted so old sandbox garages (if any) still work.
 */
function makeHttp(branchKey: string, tenant: string): AxiosInstance {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'ReceptionMate-Portal/1.0 (poole-chat)',
    // Poole uses a bespoke `Key: {apiKey}` header — NOT Authorization: Bearer.
    Key: branchKey,
  };
  const tenantValue = (tenant || '').trim();
  if (tenantValue) headers.Tenant = tenantValue;
  return axios.create({
    baseURL: getBaseUrl(),
    timeout: DEFAULT_TIMEOUT_MS,
    headers,
    validateStatus: () => true,
  });
}

/**
 * Low-level request wrapper. Logs method + path + status (never the key).
 * Throws PooleAuthError on 401, PooleError on any other non-2xx.
 */
async function request<T = unknown>(
  branchKey: string,
  tenant: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  opts: {
    params?: Record<string, string | number | undefined>;
    json?: unknown;
  } = {},
): Promise<T> {
  if (!branchKey) {
    throw new PooleAuthError('Poole branch API key is not configured');
  }
  const http = makeHttp(branchKey, tenant);
  const config: AxiosRequestConfig = {
    method,
    url: path,
    params: opts.params,
    data: opts.json,
  };

  const started = Date.now();
  const resp = await http.request(config);
  const durationMs = Date.now() - started;

  // Structured log — path + status + duration, NEVER the key value.
  console.log(
    `[POOLE_API] ${method} ${path} → ${resp.status} (${durationMs}ms)`,
  );

  if (resp.status === 429) {
    const retryHeader = resp.headers?.['retry-after'];
    const retryAfterSeconds = retryHeader ? Number(retryHeader) || undefined : undefined;
    console.warn(
      `[POOLE_API] Rate limited on ${method} ${path}. Retry-After=${retryAfterSeconds ?? 'n/a'}s`,
    );
    throw new PooleError(
      `Poole ${method} ${path} → 429 Too Many Requests`,
      { status: 429, body: resp.data, retryAfterSeconds },
    );
  }

  if (resp.status === 401) {
    throw new PooleAuthError(
      `Poole ${method} ${path} → 401 Unauthorized (branch key rejected)`,
      { status: 401, body: resp.data },
    );
  }

  if (resp.status >= 400) {
    const bodySnippet =
      typeof resp.data === 'string'
        ? resp.data.slice(0, 300)
        : JSON.stringify(resp.data).slice(0, 300);
    throw new PooleError(
      `Poole ${method} ${path} → ${resp.status}: ${bodySnippet}`,
      { status: resp.status, body: resp.data },
    );
  }

  return resp.data as T;
}

// ── VRM/registration helper (kept in sync with Poole's normalisation) ─────
function cleanReg(reg: string): string {
  return String(reg || '').toUpperCase().replace(/\s+/g, '');
}

// ═══════════════════════════════════════════════════════════════════════════
// A1 · Find customer by phone
// ═══════════════════════════════════════════════════════════════════════════
/**
 * GET /inbound/customers?phone={number}
 *
 * Poole normalises freely — spaces/dashes/parentheses/+44 are all fine.
 * Fewer than 6 digits → empty list. Returns an array (possibly empty).
 */
export async function findCustomerByPhone(
  branchKey: string,
  tenant: string,
  phone: string,
): Promise<PooleCustomer[]> {
  if (!phone) return [];
  return request<PooleCustomer[]>(branchKey, tenant, 'GET', '/inbound/customers', {
    params: { phone },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// A2 · Look up vehicle by VRM
// ═══════════════════════════════════════════════════════════════════════════
/**
 * GET /inbound/vehicles/{registration}
 *
 * Unknown registration returns 404 — we surface that as `null` so the LLM can
 * fall through to "please confirm the reg" rather than error out.
 */
export async function lookupVehicleByVrm(
  branchKey: string,
  tenant: string,
  registration: string,
): Promise<PooleVehicle | null> {
  const clean = cleanReg(registration);
  if (!clean) return null;
  try {
    return await request<PooleVehicle>(
      branchKey,
      tenant,
      'GET',
      `/inbound/vehicles/${encodeURIComponent(clean)}`,
    );
  } catch (err) {
    if (err instanceof PooleError && err.status === 404) return null;
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// B1 · Create draft booking
// ═══════════════════════════════════════════════════════════════════════════
/**
 * POST /inbound/bookings
 *
 * `callReference` is the idempotency key: repeating the same value returns
 * the existing booking (200) instead of creating a duplicate (201). Callers
 * should build this deterministically per conversation so a mid-flight retry
 * doesn't double-book.
 *
 * `branchCode` is optional (the API key already scopes to a branch); if sent
 * it must match the key's branch or the request fails with 400.
 *
 * Drafts expire after 4 hours — do NOT stash bookingRef past that window.
 */
export async function createDraftBooking(
  branchKey: string,
  tenant: string,
  callReference: string,
  branchCode?: string,
  notes?: string,
): Promise<{ bookingRef: string }> {
  const body: Record<string, unknown> = {
    callReference: String(callReference || '').slice(0, 100),
  };
  if (branchCode) body.branchCode = branchCode;
  if (notes) body.notes = String(notes).slice(0, 250);

  return request<{ bookingRef: string }>(
    branchKey,
    tenant,
    'POST',
    '/inbound/bookings',
    { json: body },
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// B2 · List services
// ═══════════════════════════════════════════════════════════════════════════
/**
 * GET /inbound/bookings/{bookingRef}/services
 *
 * Prices are in GBP and already reflect this branch's price list for this
 * booking. `serviceId` is stable and safe to persist in session state.
 */
export async function listServices(
  branchKey: string,
  tenant: string,
  bookingRef: string,
): Promise<PooleService[]> {
  return request<PooleService[]>(
    branchKey,
    tenant,
    'GET',
    `/inbound/bookings/${encodeURIComponent(bookingRef)}/services`,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// B3 · Add services to booking
// ═══════════════════════════════════════════════════════════════════════════
/**
 * POST /inbound/bookings/{bookingRef}/services
 *
 * REPLACES the booking's current selection — send the full desired set each
 * time. Returns 202. Unknown ids → 400 with the offending id named. Only
 * allowed while the booking is a draft.
 */
export async function addServicesToBooking(
  branchKey: string,
  tenant: string,
  bookingRef: string,
  serviceIds: number[],
): Promise<void> {
  await request<void>(
    branchKey,
    tenant,
    'POST',
    `/inbound/bookings/${encodeURIComponent(bookingRef)}/services`,
    { json: { serviceIds } },
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// B4 · List available slots
// ═══════════════════════════════════════════════════════════════════════════
/**
 * GET /inbound/bookings/{bookingRef}/slots?startDate=&endDate=
 *
 * Both dates optional — default is today → today+7. Max window 14 days.
 * Requires at least one service on the booking first, otherwise 409.
 * Days with no availability are omitted from the response.
 */
export async function listAvailableSlots(
  branchKey: string,
  tenant: string,
  bookingRef: string,
  startDate?: string,
  endDate?: string,
): Promise<PooleSlotDay[]> {
  const params: Record<string, string | number | undefined> = {};
  if (startDate) params.startDate = startDate;
  if (endDate) params.endDate = endDate;
  return request<PooleSlotDay[]>(
    branchKey,
    tenant,
    'GET',
    `/inbound/bookings/${encodeURIComponent(bookingRef)}/slots`,
    { params },
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// B5 · Reserve a slot
// ═══════════════════════════════════════════════════════════════════════════
/**
 * PUT /inbound/bookings/{bookingRef}/slot
 *
 * Soft hold — the slot is revalidated at confirm; if it's gone, confirm
 * returns 409 SLOT_UNAVAILABLE and the caller must re-list slots and pick
 * again. `time` must be a value returned by B4 (HH:mm 24h).
 */
export async function reserveSlot(
  branchKey: string,
  tenant: string,
  bookingRef: string,
  date: string,
  time: string,
): Promise<void> {
  await request<void>(
    branchKey,
    tenant,
    'PUT',
    `/inbound/bookings/${encodeURIComponent(bookingRef)}/slot`,
    { json: { date, time } },
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// B6 · Confirm the booking
// ═══════════════════════════════════════════════════════════════════════════
/**
 * POST /inbound/bookings/{bookingRef}/confirm
 *
 * `customer.lastName` and `vehicle.registration` are REQUIRED; everything
 * else is optional. Confirm is atomic and race-safe — two agents cannot take
 * the last slot; the loser gets 409 SLOT_UNAVAILABLE. Confirming an
 * already-confirmed booking returns the booking unchanged (safe to retry).
 *
 * Returns the full booking detail including the human-readable `reference`
 * (job number) — quote that back to the caller.
 */
export async function confirmBooking(
  branchKey: string,
  tenant: string,
  bookingRef: string,
  customer: PooleConfirmCustomer,
  vehicle: PooleConfirmVehicle,
  mileage?: number,
): Promise<PooleBookingDetail> {
  const body: Record<string, unknown> = {
    customer,
    vehicle: { ...vehicle, registration: cleanReg(vehicle.registration) },
  };
  if (typeof mileage === 'number') body.mileage = mileage;

  return request<PooleBookingDetail>(
    branchKey,
    tenant,
    'POST',
    `/inbound/bookings/${encodeURIComponent(bookingRef)}/confirm`,
    { json: body },
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// C1 · Reschedule
// ═══════════════════════════════════════════════════════════════════════════
/**
 * PUT /inbound/bookings/{bookingRef}/reschedule
 *
 * Body same as B5 (`{ date, time }`). Works on both drafts and confirmed
 * bookings; the diary is moved atomically. Unavailable new slot → 409 and
 * the ORIGINAL slot is preserved.
 */
export async function rescheduleBooking(
  branchKey: string,
  tenant: string,
  bookingRef: string,
  date: string,
  time: string,
): Promise<void> {
  await request<void>(
    branchKey,
    tenant,
    'PUT',
    `/inbound/bookings/${encodeURIComponent(bookingRef)}/reschedule`,
    { json: { date, time } },
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// C2 · Cancel with reason
// ═══════════════════════════════════════════════════════════════════════════
/**
 * PUT /inbound/bookings/{bookingRef}/cancel
 *
 * `reason` required, ≤250 chars, recorded on the job. Cancelling an already
 * cancelled booking is idempotent (200). Completed/invoiced jobs cannot be
 * cancelled through this API → 409.
 */
export async function cancelBooking(
  branchKey: string,
  tenant: string,
  bookingRef: string,
  reason: string,
): Promise<void> {
  const cleanReason = String(reason || '').slice(0, 250);
  await request<void>(
    branchKey,
    tenant,
    'PUT',
    `/inbound/bookings/${encodeURIComponent(bookingRef)}/cancel`,
    { json: { reason: cleanReason } },
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// C3 · Retrieve a booking
// ═══════════════════════════════════════════════════════════════════════════
/**
 * GET /inbound/bookings/{bookingRef}
 *
 * Same shape as the B6 confirm response. `status` is one of Pending (draft),
 * Booked, Cancelled.
 */
export async function getBooking(
  branchKey: string,
  tenant: string,
  bookingRef: string,
): Promise<PooleBookingDetail> {
  return request<PooleBookingDetail>(
    branchKey,
    tenant,
    'GET',
    `/inbound/bookings/${encodeURIComponent(bookingRef)}`,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// D1 · Branches with opening hours
// ═══════════════════════════════════════════════════════════════════════════
/**
 * GET /inbound/branches
 *
 * Returns only the branch the API key is scoped to (as an array of length 1
 * per the handover doc — spec says "returns the branch the key is scoped
 * to", so we surface it as an array to preserve future flexibility).
 */
export async function getBranches(branchKey: string, tenant: string): Promise<PooleBranch[]> {
  return request<PooleBranch[]>(branchKey, tenant, 'GET', '/inbound/branches');
}
