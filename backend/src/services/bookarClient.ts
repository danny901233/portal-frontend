/**
 * Bookar Partner API client — TypeScript port of `optimised-bookar/bookar.py`
 * used by the voice agent. Both talk to Vitara Commerce's Partner API for
 * garages running Bookar (garage-management system).
 *
 * Key difference from the Python version:
 *   - Python is single-tenant (creds from env vars) because voice runs one
 *     agent-slot per garage on LiveKit Cloud.
 *   - This TS version is INSTANCE-BASED — each garage gets its own client
 *     with its own creds + own token cache. That's because chat runs as a
 *     single Node process serving many garages, so we can't rely on env.
 *
 * Endpoints wired:
 *   Customer & Vehicle
 *     GET  /v1/customers?phone=          — caller-ID lookup + linked vehicles
 *     GET  /v1/vehicles/{vrm}            — vehicle + MOT expiry + advisories
 *   Services & Availability
 *     GET  /v1/services?vrm=             — services + prices for THIS vehicle
 *     GET  /v1/availability              — slot windows for chosen service_ids
 *   Booking
 *     POST /v1/bookings                  — create (idempotent via header)
 *     GET  /v1/bookings/{ref}            — retrieve
 *     PATCH /v1/bookings/{ref}           — reschedule
 *     POST /v1/bookings/{ref}/cancel     — cancel with reason
 *   Reference
 *     GET  /v1/branch                    — branch info + opening hours
 *
 * Auth: OAuth2 client-credentials → Bearer token. Cached per-instance with
 * automatic refresh ~60s before expiry, plus one-shot 401 retry if the
 * token expires mid-request.
 */
import axios, { AxiosError, AxiosInstance, AxiosRequestConfig } from 'axios';
import { randomUUID } from 'crypto';

// ── Types ─────────────────────────────────────────────────────────────────
export interface BookarCreds {
  clientId: string;
  clientSecret: string;
  apiBase?: string; // defaults to https://partners.bookar.app
  timeoutMs?: number; // defaults to 15000
}

export interface BookarVehicleSummary {
  id?: number;
  vrm: string;
  make?: string;
  model?: string;
}

export interface BookarCustomer {
  id: number;
  name?: string;
  first_name?: string;
  last_name?: string;
  phone?: string;
  mobile_phone?: string;
  email?: string;
  vehicles?: BookarVehicleSummary[];
}

export interface BookarVehicle {
  vrm: string;
  make?: string;
  model?: string;
  mileage?: number;
  mot_expiry?: string;
  on_file: boolean;
  customer?: { id?: number; first_name?: string; last_name?: string; name?: string } | null;
  advisories?: Array<{ date?: string; text?: string; type?: string }>;
  history?: Array<{ reference?: string; date?: string; service?: string; outcome?: string; status?: string }>;
  source?: string;
}

export interface BookarPrice {
  total: number;
  subtotal: number;
  tax: number;
  discount: number;
}

export interface BookarService {
  id: number;
  name: string;
  type: 'FIXED' | 'MATRIX' | string;
  enabled: boolean;
  price: BookarPrice;
}

export interface BookarSlot {
  date: string; // YYYY-MM-DD
  time: string; // HH:MM:SS
}

export interface BookarBookingCustomerNew {
  first_name: string;
  last_name?: string;
  email: string;
  phone: string;
  marketing_opt_in?: boolean;
}

export interface BookarBookingCustomerExisting {
  id: number;
}

export interface BookarBookingRequest {
  customer: BookarBookingCustomerNew | BookarBookingCustomerExisting;
  vehicle: { id?: number; vrm?: string; mileage?: number };
  service_ids: number[];
  slot: BookarSlot;
}

export interface BookarBookingResponse {
  reference: string;
  status: string;
  appointment?: { date: string; time: string; start?: string; end?: string };
  customer?: { name?: string; phone?: string; email?: string };
  vehicle?: { vrm?: string; make?: string; model?: string };
}

// ── Errors ────────────────────────────────────────────────────────────────
export class BookarError extends Error {
  status: number;
  body?: unknown;
  constructor(message: string, opts: { status?: number; body?: unknown } = {}) {
    super(message);
    this.name = 'BookarError';
    this.status = opts.status ?? 0;
    this.body = opts.body;
  }
}

export class BookarAuthError extends BookarError {
  constructor(message: string, opts: { status?: number; body?: unknown } = {}) {
    super(message, opts);
    this.name = 'BookarAuthError';
  }
}

// ── Client ────────────────────────────────────────────────────────────────
const DEFAULT_API_BASE = 'https://partners.bookar.app';
const DEFAULT_TIMEOUT_MS = 15_000;

export class BookarClient {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly apiBase: string;
  private readonly http: AxiosInstance;
  private token: string | null = null;
  private tokenExpiresAt = 0; // epoch seconds

  constructor(creds: BookarCreds) {
    this.clientId = (creds.clientId || '').trim();
    this.clientSecret = (creds.clientSecret || '').trim();
    this.apiBase = (creds.apiBase || DEFAULT_API_BASE).replace(/\/+$/, '');
    this.http = axios.create({
      baseURL: this.apiBase,
      timeout: creds.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'ReceptionMate-Portal/1.0 (bookar-chat)',
      },
      validateStatus: () => true, // handle errors ourselves so we can 401-retry
    });
  }

  isEnabled(): boolean {
    return Boolean(this.clientId && this.clientSecret);
  }

  // ── Token cache + refresh ───────────────────────────────────────────────
  private async fetchToken(): Promise<string> {
    if (!this.isEnabled()) {
      throw new BookarAuthError('Bookar credentials not configured (clientId/clientSecret)');
    }
    const resp = await this.http.post('/v1/auth/token', {
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });
    if (resp.status !== 200) {
      throw new BookarAuthError(
        `Bookar auth failed (${resp.status}): ${String(resp.data).slice(0, 200)}`,
        { status: resp.status, body: resp.data },
      );
    }
    const data = resp.data as { access_token?: string; token?: string; expires_in?: number };
    const token = data.access_token || data.token;
    const expiresIn = Number(data.expires_in ?? 3600);
    if (!token) {
      throw new BookarAuthError(`Bookar auth response missing access_token: ${JSON.stringify(data)}`);
    }
    // Refresh 60s before expiry as safety margin
    this.token = token;
    this.tokenExpiresAt = Math.floor(Date.now() / 1000) + Math.max(60, expiresIn - 60);
    return token;
  }

  private async getToken(): Promise<string> {
    if (this.token && Math.floor(Date.now() / 1000) < this.tokenExpiresAt) {
      return this.token;
    }
    return this.fetchToken();
  }

  private invalidateToken(): void {
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  // ── Low-level request wrapper with one-shot 401 retry ───────────────────
  private async request<T = unknown>(
    method: string,
    path: string,
    opts: {
      params?: Record<string, string | number>;
      json?: unknown;
      extraHeaders?: Record<string, string>;
      _retried401?: boolean;
    } = {},
  ): Promise<T> {
    const token = await this.getToken();
    const config: AxiosRequestConfig = {
      method,
      url: path,
      params: opts.params,
      data: opts.json,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(opts.extraHeaders || {}),
      },
    };
    const resp = await this.http.request(config);

    if (resp.status === 401 && !opts._retried401) {
      // Token just expired mid-call — invalidate + retry once
      this.invalidateToken();
      return this.request<T>(method, path, { ...opts, _retried401: true });
    }
    if (resp.status >= 400) {
      const bodySnippet = typeof resp.data === 'string'
        ? resp.data.slice(0, 300)
        : JSON.stringify(resp.data).slice(0, 300);
      throw new BookarError(
        `Bookar ${method} ${path} → ${resp.status}: ${bodySnippet}`,
        { status: resp.status, body: resp.data },
      );
    }
    return resp.data as T;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  // CUSTOMER & VEHICLE ────────────────────────────────────────────────────
  /**
   * Look up an existing customer by phone (usually the caller's number).
   * Returns the first match, or null if unknown. Customer includes `vehicles`
   * so the agent can go straight to "is this about your Ford Focus AB12 CDE?"
   */
  async findCustomerByPhone(phone: string): Promise<BookarCustomer | null> {
    if (!phone) return null;
    const data = await this.request<{ customers?: BookarCustomer[] }>('GET', '/v1/customers', {
      params: { phone },
    });
    const customers = data.customers || [];
    return customers[0] || null;
  }

  /**
   * Look up a vehicle by VRM. Returns make/model/mot_expiry/advisories/history
   * plus `on_file: true` if Bookar already has it linked to a customer here.
   * Unknown VRMs fall back to a DVLA live lookup (can take 1-4s).
   */
  async lookupVehicle(vrm: string): Promise<BookarVehicle> {
    const clean = (vrm || '').toUpperCase().replace(/\s+/g, '');
    return this.request<BookarVehicle>('GET', `/v1/vehicles/${clean}`);
  }

  // SERVICES & AVAILABILITY ───────────────────────────────────────────────
  /**
   * List services + real prices for THIS vehicle. Prices are vehicle-specific
   * — NEVER invent one; always quote what the API returns.
   */
  async listServices(vrm: string): Promise<BookarService[]> {
    const clean = (vrm || '').toUpperCase().replace(/\s+/g, '');
    const data = await this.request<{ services?: BookarService[] }>('GET', '/v1/services', {
      params: { vrm: clean },
    });
    return data.services || [];
  }

  /**
   * List available slot windows for the given service_ids between dates (YYYY-MM-DD).
   * API returns either {slots: [...]}, {availability: [...]}, or a bare array — we accept all three.
   */
  async listAvailability(
    serviceIds: number[],
    dateFrom: string,
    dateTo: string,
  ): Promise<Array<{ date: string; slots?: string[]; time?: string }>> {
    if (!serviceIds || serviceIds.length === 0) return [];
    const data = await this.request<
      | Array<{ date: string; slots?: string[]; time?: string }>
      | { slots?: unknown[]; availability?: unknown[] }
    >('GET', '/v1/availability', {
      params: {
        service_ids: serviceIds.join(','),
        from: dateFrom,
        to: dateTo,
      },
    });
    if (Array.isArray(data)) return data;
    const payload = (data.slots || data.availability || []) as Array<{
      date: string;
      slots?: string[];
      time?: string;
    }>;
    return payload;
  }

  // BOOKING — CREATE / MANAGE ────────────────────────────────────────────
  /**
   * Create a booking. Idempotent via Idempotency-Key header (auto-generated
   * if not passed). Returns the booking with a `reference` for the caller.
   */
  async createBooking(
    body: BookarBookingRequest,
    idempotencyKey?: string,
  ): Promise<BookarBookingResponse> {
    const key = idempotencyKey || randomUUID();
    return this.request<BookarBookingResponse>('POST', '/v1/bookings', {
      json: body,
      extraHeaders: { 'Idempotency-Key': key },
    });
  }

  /**
   * Retrieve an existing booking by reference.
   */
  async retrieveBooking(bookingRef: string): Promise<BookarBookingResponse> {
    return this.request<BookarBookingResponse>('GET', `/v1/bookings/${bookingRef}`);
  }

  /**
   * Reschedule an existing booking to a new {date, time} slot.
   */
  async rescheduleBooking(bookingRef: string, newSlot: BookarSlot): Promise<BookarBookingResponse> {
    return this.request<BookarBookingResponse>('PATCH', `/v1/bookings/${bookingRef}`, {
      json: { slot: newSlot },
    });
  }

  /**
   * Cancel an existing booking with a short reason string.
   */
  async cancelBooking(bookingRef: string, reason: string): Promise<{ reference?: string; status?: string; reason?: string }> {
    return this.request('POST', `/v1/bookings/${bookingRef}/cancel`, {
      json: { reason },
    });
  }

  // REFERENCE ─────────────────────────────────────────────────────────────
  /**
   * Get branch info + opening hours (per the credential's scoped branch).
   */
  async getBranch(): Promise<{
    id?: number;
    name?: string;
    address?: string;
    phone?: string;
    email?: string;
    opening_hours?: Record<string, { open?: string; close?: string; closed?: boolean }>;
  }> {
    return this.request('GET', '/v1/branch');
  }
}

// ── Convenience: build client from portal's integrationProviderConfig ────
/**
 * Extract Bookar creds from a garage's integrationProviderConfig JSON and
 * return a ready-to-use client, or null if creds aren't configured for
 * this garage. Supports both flat and nested shapes (mirrors how Tyresoft
 * chat handles its creds for backward compat).
 */
export function bookarClientFromConfig(
  integrationProviderConfig: unknown,
): BookarClient | null {
  if (!integrationProviderConfig || typeof integrationProviderConfig !== 'object') return null;
  const raw = integrationProviderConfig as Record<string, unknown>;
  // Nested: { bookar: { bookarClientId, ... } } OR flat at top level
  const src = ((raw.bookar as Record<string, unknown>) || raw);
  const clientId = String(src.bookarClientId || src.clientId || '').trim();
  const clientSecret = String(src.bookarClientSecret || src.clientSecret || '').trim();
  const apiBase = String(src.bookarApiBase || src.apiBase || '').trim() || undefined;
  if (!clientId || !clientSecret) return null;
  return new BookarClient({ clientId, clientSecret, apiBase });
}
