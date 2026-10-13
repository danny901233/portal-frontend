// ---------------------------------------------------------------------------
// Resolving a booking we placed to the garage's own job number
// ---------------------------------------------------------------------------
// The booking API never tells us the job number. Garage Hive's online-booking API answers a
// successful booking with its OWN id — a bare integer like 1739272 — and nothing on the Business
// Central side records it: on all 10 of Speedy Spanners' agent-placed jobsheets
// `externalDocumentNo`, `marketingChannel`, `keyTagText` and `serviceAdvisor` are empty, and there
// is no source/provider/createdBy field among the 69 a jobsheet carries. So 1739272 cannot be
// turned into SJ000829 by asking.
//
// What CAN be joined is registration + appointment date, because that pair identifies a visit:
//   reg + bookingDate  ->  the jobsheet  ->  its number  ->  the invoice
// and the last step is free, because in Business Central a posted sales invoice carries the SAME
// number as the jobsheet it came from (SJ000827 as a jobsheet posts as SJ000827 as an invoice).
//
// Timing matters. `jobsheets` holds OPEN work only — a documentType filter for anything else
// returns zero rows — so once the garage posts the job it leaves that list and the link can no
// longer be made. This has to run while the job is still in the diary, which is why the number is
// stored on the Call rather than recomputed on demand.
//
// Registration alone is NOT enough, and neither are the customer's details:
//   - the invoice carries no registration at all, on the header or the lines;
//   - 2 of Speedy's 10 agent-placed jobsheets are raised against a different customer than the
//     one who owns the vehicle (one of them a record whose entire name is "07736326326"), so a
//     customer-keyed join lands on the wrong account.
// ---------------------------------------------------------------------------

import { resolveCreds, type GarageHiveCreds } from './garageHiveBc.js';

/** A jobsheet as the sweep needs it. Mirrors the Business Central field names. */
export interface CandidateJob {
  number: string;
  serviceType?: string;
  vehicleRegistrationNo?: string;
  /** The appointment. Garage Hive writes an absent date as 0001-01-01, not null. */
  bookingDate?: string;
  /** The slot time, as HH:MM:SS. Matching compares the day only, but storing the real time means
   *  a recovered appointment reads correctly rather than sitting at midnight. */
  bookingTime?: string;
  /** When the job was raised, which is not the appointment. */
  documentDate?: string;
  locationCode?: string;
}

export interface BookingToMatch {
  registration?: string | null;
  bookingAt?: Date | null;
}

/** A Garage Hive "empty date". Not null, and not a date 2000 years ago either. */
const EMPTY_DATE = '0001-01-01';

/**
 * How far a job may have moved from the date we booked and still be the same booking.
 *
 * Not zero: garages reschedule, and our bookingAt then reads a day or two stale. Dropping those
 * would under-report silently, which is the failure mode nobody notices. Not wide either — the
 * whole reason for using the date is that it distinguishes one visit from the next, and a window
 * of weeks throws that away and puts us back with the ambiguous customer-level guess.
 */
const RESCHEDULE_TOLERANCE_DAYS = 3;

export function normaliseReg(reg?: string | null): string {
  return String(reg ?? '').replace(/\s+/g, '').trim().toUpperCase();
}

/**
 * Does this service type mark a job placed through the online-booking API?
 *
 * Speedy Spanners name their online-booking service types with an "OB" prefix — OB 4MOT, OB MI,
 * OB INTSERV, OB DIAG, and a bare OB. Across their open diary that held 10 for 10 with no false
 * positives, which makes it a good corroborating signal.
 *
 * It is NOT a join key and must never be used as one. The prefix is the garage's own naming, not
 * something Garage Hive sets, so it can change without notice and it could never distinguish our
 * bookings from any other online source — Garage Hive's own web-chat booking widget on the
 * garage's site would look identical.
 *
 * The word boundary is load-bearing: "OBD DIAG" is on-board diagnostics, booked by staff.
 */
export function isAgentPlacedJob(serviceType?: string | null): boolean {
  return /^OB\b/i.test(String(serviceType ?? '').trim());
}

function toIsoDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function dayGap(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.abs(Math.round(ms / 86_400_000));
}

/**
 * The jobsheet for this booking, or null when nothing can be said with confidence.
 *
 * Returns null rather than a best guess on ambiguity. A wrong job number is worse than no job
 * number: it would permanently attach somebody else's invoice to our booking, and because it is
 * stored rather than recomputed, nothing would ever revisit it.
 */
export function matchJobsheet(booking: BookingToMatch, candidates: CandidateJob[]): CandidateJob | null {
  const reg = normaliseReg(booking.registration);
  if (!reg || !booking.bookingAt) return null;

  const wanted = toIsoDay(booking.bookingAt);
  if (wanted === EMPTY_DATE) return null;

  const onThisCar = candidates.filter((job) => {
    if (normaliseReg(job.vehicleRegistrationNo) !== reg) return false;
    const booked = (job.bookingDate || '').slice(0, 10);
    return Boolean(booked) && booked !== EMPTY_DATE;
  });

  // An exact date is unambiguous by definition — a neighbouring job within tolerance does not
  // make it doubtful, so this is settled before the fuzzy pass runs.
  const exact = onThisCar.filter((job) => job.bookingDate!.slice(0, 10) === wanted);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;

  const near = onThisCar.filter(
    (job) => dayGap(wanted, job.bookingDate!.slice(0, 10)) <= RESCHEDULE_TOLERANCE_DAYS,
  );
  return near.length === 1 ? near[0] : null;
}

// ---------------------------------------------------------------------------
// Fetching the candidates
// ---------------------------------------------------------------------------

/**
 * The garage's open jobsheets, for the branch this garage is (when it shares a company).
 *
 * Read-only. Asks for the whole open diary in one paged call rather than per registration: the
 * open list is a few hundred rows against tens of thousands of vehicles, and one call per booking
 * put an earlier reminder pull past the server's 30s timeout.
 */
export async function fetchOpenJobsheets(garageId: string): Promise<CandidateJob[]> {
  const creds = await resolveCreds(garageId);
  if (!creds) return [];
  return fetchOpenJobsheetsWith(creds);
}

async function fetchOpenJobsheetsWith(creds: GarageHiveCreds): Promise<CandidateJob[]> {
  const { default: axios } = await import('axios');
  const token = await getBcToken(creds);
  const select = 'number,serviceType,vehicleRegistrationNo,bookingDate,bookingTime,documentDate,locationCode';
  const base =
    `https://api.businesscentral.dynamics.com/v2.0/${creds.tenantId}/${creds.environmentName}` +
    `/api/garageHive/service/v2.0/companies(${creds.companyId})/jobsheets?$select=${select}`;

  const out: CandidateJob[] = [];
  let next: string | undefined = base;
  // Follow @odata.nextLink. A bare page is an arbitrary contiguous block of document numbers, and
  // concluding anything from one has produced a wrong answer here before.
  for (let page = 0; page < 20 && next; page++) {
    const res: { data?: { value?: CandidateJob[]; '@odata.nextLink'?: string } } = await axios.get(next, {
      headers: { Authorization: `Bearer ${token}` },
    });
    out.push(...(res.data?.value ?? []));
    next = res.data?.['@odata.nextLink'];
  }

  // A garage that shares a Business Central company with its sister branches (Ecotest, Great
  // Hollands and JDK are one company split by locationCode) must not pick up their jobs.
  if (creds.locationCode) {
    const want = creds.locationCode.trim().toUpperCase();
    return out.filter((job) => (job.locationCode || '').trim().toUpperCase() === want);
  }
  return out;
}

async function getBcToken(creds: GarageHiveCreds): Promise<string> {
  const { default: axios } = await import('axios');
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
  return res.data.access_token as string;
}

// ---------------------------------------------------------------------------
// Message-only garages
// ---------------------------------------------------------------------------
// Ecotest, Great Hollands and JDK Camberley publish no slots, so the agent books nothing: it
// captures what the caller wants and the date they would like, and the garage rings back and
// books it by hand. There is therefore no appointment date we set, and no "OB" service type to
// recognise — the resulting job is raised by staff and looks like any other.
//
// Attribution is instead: the caller ASKED for a date, and a job that did not exist when they
// rang appeared shortly afterwards.
//
// Both halves of that are load-bearing, and skipping either produces a number that cannot be
// shown to a garage. Over six weeks on these three, "a reg we captured, then an invoice for that
// customer" came to £62,769 — but 36 of the matches, worth £12,737, were invoiced the same day.
// That is the signature of someone ringing about a car already in the bay: a progress chase, not
// work the agent won. Requiring a preferred booking date removes them at source, because a
// progress-chase call contains no date; requiring the job to post-date the call removes the rest.

export interface MessageLeadToMatch {
  registration?: string | null;
  /** When the call happened. A job raised before this was not won by it. */
  calledAt: Date;
  /**
   * The date the caller asked for. REQUIRED — a call without one is an enquiry or a progress
   * chase, and counting it is how the figure stopped being defensible.
   */
  preferredDate?: Date | null;
}

/**
 * How long after the message the garage's callback booking may be raised and still count.
 *
 * Long enough for a garage to work through a message backlog over a week or two, short enough
 * that an unrelated return visit months later is not credited to this call.
 */
const CALLBACK_WINDOW_DAYS = 45;

/**
 * The job the garage raised off the back of this message, or null.
 *
 * Deliberately looser than `matchJobsheet`: the garage books by hand and may put the car in on a
 * different day than the caller asked for, so the preferred date qualifies the call rather than
 * being matched against. What is matched is "a job on this car that did not exist before we rang".
 */
export function matchMessageLead(
  lead: MessageLeadToMatch,
  candidates: CandidateJob[],
): CandidateJob | null {
  const reg = normaliseReg(lead.registration);
  // No preferred date means this was never a booking request. This is the whole qualifying rule.
  if (!reg || !lead.preferredDate) return null;

  const calledOn = toIsoDay(lead.calledAt);
  const deadline = toIsoDay(new Date(lead.calledAt.getTime() + CALLBACK_WINDOW_DAYS * 86_400_000));

  const ours = candidates
    .filter((job) => normaliseReg(job.vehicleRegistrationNo) === reg)
    .filter((job) => {
      const raised = (job.documentDate || '').slice(0, 10);
      // Raised before the call: the car was already booked in and the agent did not win it.
      // An absent documentDate cannot clear that bar, so it is excluded rather than assumed.
      if (!raised || raised === EMPTY_DATE) return false;
      return raised >= calledOn && raised <= deadline;
    })
    .sort((a, b) => (a.documentDate || '').localeCompare(b.documentDate || ''));

  // The callback from THIS message is the first job that appeared, not a later return visit.
  return ours[0] ?? null;
}

/**
 * Combine a diary's date and time strings into the appointment timestamp.
 *
 * Returns null rather than a partial guess. A date with an unreadable time is still a usable
 * appointment (the sweep matches on the day), but an unreadable DATE is not, and defaulting it to
 * "now" would attach the booking to whatever job happened to be raised today.
 *
 * Built as UTC on purpose. These are wall-clock garage appointments ("27 Oct, 08:30"), and the
 * only thing done with them is compare the date portion against Garage Hive's own date strings,
 * which carry no zone either. Parsing them in the server's local zone would shift the day either
 * side of midnight for an early or late slot and match the wrong day.
 */
export function bookingAtFrom(date?: string | null, time?: string | null): Date | null {
  const day = String(date ?? '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day === EMPTY_DATE) return null;

  const raw = String(time ?? '').trim();
  const hhmm = raw.match(/^(\d{1,2}):(\d{2})/);
  const hours = hhmm ? Number(hhmm[1]) : 0;
  const minutes = hhmm ? Number(hhmm[2]) : 0;
  const clock = hours < 24 && minutes < 60
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
    : '00:00';

  const parsed = new Date(`${day}T${clock}:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// ---------------------------------------------------------------------------
// Reading back what the job invoiced for
// ---------------------------------------------------------------------------
// This needs no matching at all. In Business Central a posted sales invoice carries the SAME
// number as the jobsheet it came from — SJ000827 as a job posts as SJ000827 as an invoice — so the
// job number resolved earlier IS the lookup key.
//
// It lives on the STANDARD BC API (api/v2.0/.../salesInvoices), not the garageHive groups, which
// expose no invoice entity at all. The invoice carries no registration, on the header or the
// lines, which is exactly why the job number had to be caught while the jobsheet was still open.

/** A sales invoice, as the sweep needs it. Mirrors the BC field names. */
export interface RawInvoice {
  number?: string;
  postingDate?: string;
  status?: string;
  totalAmountExcludingTax?: number | null;
  totalAmountIncludingTax?: number | null;
}

export interface InvoiceFacts {
  /** EX VAT — the garage's revenue, and the basis every figure we quote uses. */
  invoicedValue: number;
  invoicedAt: Date;
  /** BC's own word: Draft | Open | Paid | Corrective | Canceled. */
  invoiceStatus: string;
}

/**
 * Turn a BC invoice row into the three facts worth storing, or null if it says nothing usable.
 *
 * Zero and negative values are REAL answers and are kept. A job can invoice at nothing (a goodwill
 * check-over, or the work moved onto another invoice), and a credit note is negative — dropping
 * either would leave the sweep re-reading the same invoice every night and would report refunded
 * work as if it had simply not happened.
 */
export function parseInvoice(row: RawInvoice | null | undefined): InvoiceFacts | null {
  if (!row) return null;

  const amount = row.totalAmountExcludingTax;
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return null;

  const posted = (row.postingDate || '').slice(0, 10);
  if (!posted || posted === EMPTY_DATE) return null;
  const invoicedAt = new Date(`${posted}T00:00:00Z`);
  if (Number.isNaN(invoicedAt.getTime())) return null;

  return {
    invoicedValue: amount,
    invoicedAt,
    invoiceStatus: (row.status || '').trim() || 'Unknown',
  };
}

/** Split job numbers into URL-sized batches. A hundred in one $filter is rejected outright. */
export function chunkJobNumbers(numbers: string[], size = 20): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < numbers.length; i += size) out.push(numbers.slice(i, i + size));
  return out;
}

/**
 * An OData filter matching any of these job numbers.
 *
 * OR within ONE field, which BC allows — an OR across two different fields it refuses outright
 * ("OR operator not supported on distinct fields"). AND here would match nothing.
 */
export function invoiceFilter(numbers: string[]): string {
  return numbers.map((n) => `number eq ${odataStrLocal(n)}`).join(' or ');
}

/** BC OData string literal: single quotes are doubled. */
function odataStrLocal(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Look up invoices for these job numbers. Read-only.
 *
 * A number with no invoice yet is simply absent from the result — the job is still open, and the
 * sweep will ask again tomorrow.
 */
export async function fetchInvoicesByJobNumber(
  garageId: string,
  jobNumbers: string[],
): Promise<Map<string, InvoiceFacts>> {
  const out = new Map<string, InvoiceFacts>();
  if (!jobNumbers.length) return out;

  const creds = await resolveCreds(garageId);
  if (!creds) return out;

  const { default: axios } = await import('axios');
  const token = await getBcToken(creds);
  const select = 'number,postingDate,status,totalAmountExcludingTax,totalAmountIncludingTax';
  const base =
    `https://api.businesscentral.dynamics.com/v2.0/${creds.tenantId}/${creds.environmentName}` +
    `/api/v2.0/companies(${creds.companyId})/salesInvoices`;

  for (const chunk of chunkJobNumbers(jobNumbers)) {
    const url = `${base}?$filter=${encodeURIComponent(invoiceFilter(chunk))}&$select=${select}`;
    const res: { data?: { value?: RawInvoice[] } } = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    for (const row of res.data?.value ?? []) {
      const facts = parseInvoice(row);
      if (facts && row.number) out.set(row.number, facts);
    }
  }
  return out;
}
