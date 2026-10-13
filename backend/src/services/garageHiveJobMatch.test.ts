import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  matchJobsheet,
  matchMessageLead,
  bookingAtFrom,
  parseInvoice,
  chunkJobNumbers,
  invoiceFilter,
  isAgentPlacedJob,
  normaliseReg,
  type CandidateJob,
} from './garageHiveJobMatch.js';

// Why this is tested rather than eyeballed: the figure it produces gets quoted to garages. The
// first pass at valuing Speedy Spanners' bookings matched "any invoice for that customer after
// the booking" and over-read the total by £1,795 on 65 bookings, because a repeat customer's
// later unrelated work counted as ours. Every assertion below is one way that goes wrong.

const job = (over: Partial<CandidateJob>): CandidateJob => ({
  number: 'SJ000001',
  serviceType: 'OB 4MOT',
  vehicleRegistrationNo: 'SM68WTG',
  bookingDate: '2026-10-27',
  documentDate: '2026-10-13',
  locationCode: 'MAIN',
  ...over,
});

test('a booking matches the jobsheet with the same registration and appointment date', () => {
  const hit = matchJobsheet({ registration: 'SM68WTG', bookingAt: new Date('2026-10-27T08:30:00Z') }, [job({})]);
  assert.equal(hit?.number, 'SJ000001');
});

test('registration comparison ignores case and spacing', () => {
  const hit = matchJobsheet(
    { registration: ' sm68 wtg ', bookingAt: new Date('2026-10-27T08:30:00Z') },
    [job({})],
  );
  assert.equal(hit?.number, 'SJ000001', 'a reg typed with a space must still match');
});

// The appointment date is the whole point of the pair. Matching on registration alone is what
// made the old inference ambiguous: a car that visits three times has three jobs.
test('the same car on a different date is NOT a match', () => {
  const hit = matchJobsheet(
    { registration: 'SM68WTG', bookingAt: new Date('2026-11-18T08:30:00Z') },
    [job({})],
  );
  assert.equal(hit, null, 'a different appointment date is a different visit');
});

test('a different car on the same date is NOT a match', () => {
  const hit = matchJobsheet(
    { registration: 'YH61PDV', bookingAt: new Date('2026-10-27T08:30:00Z') },
    [job({})],
  );
  assert.equal(hit, null);
});

// Garage Hive reschedules happen: the garage moves the job a day or two and our bookingAt is then
// stale. A tight window still beats the 45-day customer guess, but zero tolerance would drop
// every rescheduled job and silently under-report.
test('a job moved by a day or two still matches, the same car moved by a fortnight does not', () => {
  const moved = [job({ bookingDate: '2026-10-29' })];
  assert.equal(
    matchJobsheet({ registration: 'SM68WTG', bookingAt: new Date('2026-10-27T08:30:00Z') }, moved)?.number,
    'SJ000001',
    'a two-day reschedule is the same booking',
  );
  const movedFar = [job({ bookingDate: '2026-11-20' })];
  assert.equal(
    matchJobsheet({ registration: 'SM68WTG', bookingAt: new Date('2026-10-27T08:30:00Z') }, movedFar),
    null,
    'a month later is a different visit, not a reschedule',
  );
});

// Ambiguity must be refused, not guessed. Two jobs on the same car within the tolerance window
// means we cannot say which one we placed, and a wrong job number is worse than none: it would
// attach somebody else's invoice value to our booking permanently.
test('two candidate jobs on the same car within tolerance, neither exact, returns nothing', () => {
  // Both one day either side of the date we booked, so nothing distinguishes them.
  const both = [
    job({ number: 'SJ000001', bookingDate: '2026-10-26' }),
    job({ number: 'SJ000002', bookingDate: '2026-10-28' }),
  ];
  assert.equal(
    matchJobsheet({ registration: 'SM68WTG', bookingAt: new Date('2026-10-27T08:30:00Z') }, both),
    null,
    'an ambiguous match must be refused',
  );
});

test('an exact date match wins over a nearby one rather than reading as ambiguous', () => {
  const both = [job({ number: 'SJ000002', bookingDate: '2026-10-28' }), job({ number: 'SJ000001', bookingDate: '2026-10-27' })];
  assert.equal(
    matchJobsheet({ registration: 'SM68WTG', bookingAt: new Date('2026-10-27T08:30:00Z') }, both)?.number,
    'SJ000001',
    'the exact date is not ambiguous just because a neighbour exists',
  );
});

test('a booking with no appointment date cannot be matched at all', () => {
  assert.equal(matchJobsheet({ registration: 'SM68WTG', bookingAt: null }, [job({})]), null);
  assert.equal(matchJobsheet({ registration: '', bookingAt: new Date('2026-10-27') }, [job({})]), null);
});

// Garage Hive returns an empty date as 0001-01-01 rather than null, and that must never be
// treated as a real appointment that happens to be 2000 years ago.
test("Garage Hive's empty date 0001-01-01 never matches", () => {
  const hit = matchJobsheet(
    { registration: 'SM68WTG', bookingAt: new Date('0001-01-01T00:00:00Z') },
    [job({ bookingDate: '0001-01-01' })],
  );
  assert.equal(hit, null);
});

// ── The "was this ours?" marker ───────────────────────────────────────────────────────────────
// Speedy Spanners prefix their online-booking service types "OB" (OB 4MOT, OB MI, OB DIAG). It
// held 10/10 with no false positives, but it is the GARAGE's naming convention, not a flag Garage
// Hive sets — so it is a corroborating signal, never the join key.

test('the OB service-type prefix identifies an online booking', () => {
  assert.equal(isAgentPlacedJob('OB 4MOT'), true);
  assert.equal(isAgentPlacedJob('OB'), true);
  assert.equal(isAgentPlacedJob('ob intserv'), true, 'case must not matter');
});

test('service types that merely begin with the letters OB are not online bookings', () => {
  assert.equal(isAgentPlacedJob('OBD DIAG'), false, '"OBD" is on-board diagnostics, not a booking');
  assert.equal(isAgentPlacedJob('MOT4'), false);
  assert.equal(isAgentPlacedJob('REPAIR'), false);
  assert.equal(isAgentPlacedJob(''), false);
  assert.equal(isAgentPlacedJob(undefined), false);
});

test('normaliseReg strips spacing and case but keeps the characters', () => {
  assert.equal(normaliseReg(' sm68 wtg '), 'SM68WTG');
  assert.equal(normaliseReg('J4LDY'), 'J4LDY');
  assert.equal(normaliseReg(null), '');
});

// ── Message-only garages (Ecotest, Great Hollands, JDK Camberley) ─────────────────────────────
// These three take no bookings: the agent captures a preferred date and the garage rings back and
// books it by hand. So there is no appointment date WE set and no "OB" service type — the job is
// raised by staff like any other. Attribution has to be: the caller asked for a date, and a job
// that did not exist when they rang appeared afterwards.
//
// The qualifying rule is the important half. A first pass counted "any invoice for that customer
// after any call where we caught a registration" and reported £62,769 over six weeks; 36 of those
// matches were invoiced the SAME DAY, worth £12,737, which is the signature of somebody ringing
// about a car already in the workshop. Requiring a preferred booking date excludes those at
// source, because a progress-chase call has no date in it.

test('a message lead matches a job raised after the call', () => {
  const hit = matchMessageLead(
    { registration: 'LM65TWV', calledAt: new Date('2026-09-01T10:00:00Z'), preferredDate: new Date('2026-09-04') },
    [job({ number: 'SJ062583', serviceType: 'MOT4', vehicleRegistrationNo: 'LM65TWV', bookingDate: '2026-09-04', documentDate: '2026-09-02' })],
  );
  assert.equal(hit?.number, 'SJ062583');
});

// The anti-contamination rule, and the reason the raw figure was not quotable.
test('a job that already existed when they rang is NOT ours', () => {
  const hit = matchMessageLead(
    { registration: 'LM65TWV', calledAt: new Date('2026-09-05T10:00:00Z'), preferredDate: new Date('2026-09-08') },
    [job({ number: 'SJ062583', serviceType: 'MOT4', vehicleRegistrationNo: 'LM65TWV', bookingDate: '2026-09-08', documentDate: '2026-09-01' })],
  );
  assert.equal(hit, null, 'the car was already booked in before the call — we did not win it');
});

// The preferred date is no longer required. It is only ever present when the model passes an
// optional parameter, so requiring it meant real bookings going uncounted indefinitely. The
// "job did not exist when they rang" rule is what actually excludes a progress chase.
test('a call with no preferred date still counts when a job appeared afterwards', () => {
  const candidates = [job({ number: 'SJ062583', serviceType: 'MOT4', vehicleRegistrationNo: 'LM65TWV', bookingDate: '2026-09-04', documentDate: '2026-09-02' })];
  assert.equal(
    matchMessageLead({ registration: 'LM65TWV', calledAt: new Date('2026-09-01T10:00:00Z'), preferredDate: null }, candidates)?.number,
    'SJ062583',
  );
});

// Fourteen days, not forty-five. With no preferred date to qualify the call, the window is the
// main thing standing between "the advisor rang them back" and "they came back weeks later of
// their own accord, and we took the credit".
test('a job raised beyond the fortnight is not attributed', () => {
  const beyond = [job({ number: 'SJ062583', serviceType: 'MOT4', vehicleRegistrationNo: 'LM65TWV', bookingDate: '2026-09-20', documentDate: '2026-09-18' })];
  assert.equal(
    matchMessageLead({ registration: 'LM65TWV', calledAt: new Date('2026-09-01T10:00:00Z'), preferredDate: null }, beyond),
    null,
    '17 days later is outside the callback window',
  );
  const inside = [job({ number: 'SJ062583', serviceType: 'MOT4', vehicleRegistrationNo: 'LM65TWV', bookingDate: '2026-09-16', documentDate: '2026-09-14' })];
  assert.equal(
    matchMessageLead({ registration: 'LM65TWV', calledAt: new Date('2026-09-01T10:00:00Z'), preferredDate: null }, inside)?.number,
    'SJ062583',
    '13 days later is inside it',
  );
});

test('the earliest qualifying job wins when a car returns more than once', () => {
  const hit = matchMessageLead(
    { registration: 'LM65TWV', calledAt: new Date('2026-09-01T10:00:00Z'), preferredDate: new Date('2026-09-04') },
    [
      job({ number: 'SJ062999', serviceType: 'REPAIR', vehicleRegistrationNo: 'LM65TWV', bookingDate: '2026-09-25', documentDate: '2026-09-20' }),
      job({ number: 'SJ062583', serviceType: 'MOT4', vehicleRegistrationNo: 'LM65TWV', bookingDate: '2026-09-04', documentDate: '2026-09-02' }),
    ],
  );
  assert.equal(hit?.number, 'SJ062583', 'the callback from this message is the first job, not a later return visit');
});

// ── bookingAtFrom ─────────────────────────────────────────────────────────────────────────────

test('bookingAtFrom combines a diary date and time', () => {
  assert.equal(bookingAtFrom('2026-10-27', '08:30')?.toISOString(), '2026-10-27T08:30:00.000Z');
  assert.equal(bookingAtFrom('2026-10-27', '08:30:00')?.toISOString(), '2026-10-27T08:30:00.000Z');
});

// Matching only ever compares the DAY, so a missing time must not cost us the booking.
test('a missing or unreadable time still yields the appointment day', () => {
  assert.equal(bookingAtFrom('2026-10-27', '')?.toISOString(), '2026-10-27T00:00:00.000Z');
  assert.equal(bookingAtFrom('2026-10-27', null)?.toISOString(), '2026-10-27T00:00:00.000Z');
  assert.equal(bookingAtFrom('2026-10-27', 'morning')?.toISOString(), '2026-10-27T00:00:00.000Z');
  assert.equal(bookingAtFrom('2026-10-27', '99:99')?.toISOString(), '2026-10-27T00:00:00.000Z');
});

// An unreadable DATE is different in kind: defaulting it would attach the booking to whatever job
// was raised today, so it must refuse.
test('an unreadable date returns null rather than guessing', () => {
  assert.equal(bookingAtFrom('', '08:30'), null);
  assert.equal(bookingAtFrom(null, '08:30'), null);
  assert.equal(bookingAtFrom('Tuesday 27th October', '08:30'), null);
  assert.equal(bookingAtFrom('0001-01-01', '08:30'), null, "Garage Hive's empty date is not an appointment");
});

// The slot is a wall-clock garage time. Parsing in the server's local zone would move an 08:30 or
// a late slot across midnight and match the wrong day.
test('an early and a late slot both stay on the booked day', () => {
  assert.equal(bookingAtFrom('2026-10-27', '00:15')?.toISOString().slice(0, 10), '2026-10-27');
  assert.equal(bookingAtFrom('2026-10-27', '23:45')?.toISOString().slice(0, 10), '2026-10-27');
});

// ── Reading the invoice back ──────────────────────────────────────────────────────────────────
// No matching needed here: in Business Central a posted sales invoice carries the SAME number as
// the jobsheet it came from, so the job number IS the lookup key. What needs testing is the
// parsing, because this value gets shown to garages as revenue.

test('an invoice is parsed into the value, date and status', () => {
  const got = parseInvoice({
    number: 'SJ000727', postingDate: '2026-10-07', status: 'Paid',
    totalAmountExcludingTax: 133.64, totalAmountIncludingTax: 160.37,
  });
  assert.equal(got?.invoicedValue, 133.64, 'ex VAT is the garage revenue figure');
  assert.equal(got?.invoiceStatus, 'Paid');
  assert.equal(got?.invoicedAt?.toISOString().slice(0, 10), '2026-10-07');
});

// A job can be invoiced at nothing — a goodwill check-over, or work moved onto another invoice.
// That is a real answer, not a missing one, and it must stick so the sweep stops re-reading it.
test('a zero-value invoice is recorded, not discarded', () => {
  const got = parseInvoice({ number: 'SJ000620', postingDate: '2026-10-01', status: 'Paid', totalAmountExcludingTax: 0 });
  assert.equal(got?.invoicedValue, 0);
  assert.equal(got?.invoiceStatus, 'Paid');
});

test('a credit note comes through as a negative value rather than being dropped', () => {
  const got = parseInvoice({ number: 'SJ000700', postingDate: '2026-10-02', status: 'Paid', totalAmountExcludingTax: -54.85 });
  assert.equal(got?.invoicedValue, -54.85, 'a refunded job must not read as £0 of work');
});

test('an unpostable or unreadable invoice yields nothing', () => {
  assert.equal(parseInvoice(null), null);
  assert.equal(parseInvoice({ number: 'SJ1', postingDate: '', status: 'Draft', totalAmountExcludingTax: 10 }), null);
  assert.equal(parseInvoice({ number: 'SJ1', postingDate: '0001-01-01', status: 'Draft', totalAmountExcludingTax: 10 }), null,
    "Garage Hive's empty date is not a posting date");
  assert.equal(parseInvoice({ number: 'SJ1', postingDate: '2026-10-02', status: 'Paid', totalAmountExcludingTax: null }), null,
    'no amount means nothing to record');
});

// A Draft is not money. It is kept rather than filtered out so a dashboard can exclude it without
// another API round trip — but it must be visibly a draft.
test('a draft invoice keeps its status so it can be excluded from revenue', () => {
  const got = parseInvoice({ number: 'SJ000900', postingDate: '2026-10-10', status: 'Draft', totalAmountExcludingTax: 95 });
  assert.equal(got?.invoiceStatus, 'Draft');
  assert.equal(got?.invoicedValue, 95);
});

// BC refuses an OR across two different fields but allows one field against a list, which is all
// this needs. Chunking matters: the filter goes in a URL, and a hundred job numbers in one query
// is a request the API rejects outright.
test('job numbers are batched into chunks for the filter', () => {
  const numbers = Array.from({ length: 47 }, (_, i) => `SJ${String(i).padStart(6, '0')}`);
  const chunks = chunkJobNumbers(numbers, 20);
  assert.deepEqual(chunks.map((c) => c.length), [20, 20, 7]);
  assert.equal(chunks.flat().length, 47, 'no job number may be lost in the chunking');
});

test('the filter quotes each number and ORs within the single number field', () => {
  const filter = invoiceFilter(['SJ000727', "SJ'X"]);
  assert.equal(filter, "number eq 'SJ000727' or number eq 'SJ''X'");
  assert.ok(!filter.includes(' and '), 'an AND here would return nothing');
});
