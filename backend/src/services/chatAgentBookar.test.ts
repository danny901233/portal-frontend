import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isClockTime,
  toWireTime,
  normaliseTime,
  looksLikeVrm,
  isSlotInFuture,
  describeAppointment,
  nextBookingAttemptAllowed,
  dropOffDirective,
} from './chatAgentBookar.js';

// ---------------------------------------------------------------------------
// Drop-off slot tokens
//
// Bookar's availability does not always answer with a clock time. EAC Telford's
// services 2 and 6 return "AM_DR" — an AM drop-off — for every open day, so for
// those services a token is the ONLY thing the diary ever offers.
//
// "AM_DR" is five characters, and the old wire-format test was `time.length === 5`,
// so it padded the token into "AM_DR:00" and posted that. Bookar replied
// 400 {"app_time":["Time has wrong format. Use one of these formats instead:
// hh:mm[:ss[.uuuuuu]]."]} and Mikey's £186 interim service died at the last step
// on 10 Oct, one message after he gave his email.
// ---------------------------------------------------------------------------

test('a clock time is a clock time, a drop-off token is not', () => {
  assert.equal(isClockTime('08:00'), true);
  assert.equal(isClockTime('08:15:00'), true);
  assert.equal(isClockTime('9:00'), true);

  assert.equal(isClockTime('AM_DR'), false);
  assert.equal(isClockTime('PM_DR'), false);
  assert.equal(isClockTime('AM_DROP'), false);
  assert.equal(isClockTime(''), false);
});

test('the wire format pads a real time and never touches a token', () => {
  assert.equal(toWireTime('08:00'), '08:00:00');
  assert.equal(toWireTime('08:15:00'), '08:15:00');
  // Single-digit hour: the old slice(0,5) turned "9:00:00" into "9:00:" — also invalid.
  assert.equal(toWireTime('9:00'), '09:00:00');
  assert.equal(toWireTime('9:00:00'), '09:00:00');

  // The regression itself: this must never become "AM_DR:00" again.
  assert.equal(toWireTime('AM_DR'), 'AM_DR');
  assert.notEqual(toWireTime('AM_DR'), 'AM_DR:00');
});

test('normalising a time leaves a drop-off token whole', () => {
  // "AM_DROP" would have been sliced down to "AM_DR" — a token mangled into a
  // different token, which then matches nothing in the availability cross-check.
  assert.equal(normaliseTime('AM_DROP'), 'AM_DROP');
  assert.equal(normaliseTime('AM_DR'), 'AM_DR');

  // Clock times still normalise to HH:MM, and a single-digit hour now pads, so
  // the LLM saying "9:00" matches the diary's "09:00:00" instead of being
  // rejected as a slot we never offered.
  assert.equal(normaliseTime('09:00:00'), '09:00');
  assert.equal(normaliseTime('9:00'), '09:00');
  assert.equal(normaliseTime('08:30'), '08:30');
});

test('a drop-off day is still in the future', () => {
  // An unparseable time must not be read as midnight, or every drop-off day gets
  // filtered out of availability and the agent offers nothing at all.
  const now = { date: '2026-10-12', minutes: 14 * 60 };
  assert.equal(isSlotInFuture('2026-10-13', 'AM_DR', now), true);
  assert.equal(isSlotInFuture('2026-10-12', 'AM_DR', now), true);
  assert.equal(isSlotInFuture('2026-10-11', 'AM_DR', now), false);
});

// ---------------------------------------------------------------------------
// Registration gate
//
// Every one of these strings was passed to bk_lookup_vehicle as a `vrm` by the
// live agent between 23 Sep and 6 Oct. Bookar 404s on all of them, and the agent
// then read the miss back to the customer as though we had checked their vehicle:
// "I'm sorry, but I couldn't find any information for your VW Touran" — to Aatif
// Janjua, who had never been asked for a registration at all.
// ---------------------------------------------------------------------------

test('a vehicle description is not a registration', () => {
  assert.equal(looksLikeVrm('2019 VW Touran 1.6 TDI'), false);
  assert.equal(looksLikeVrm('BMW 330E 2016'), false);
  assert.equal(looksLikeVrm('T4 TRANSPORTER'), false);
  assert.equal(looksLikeVrm('Renault Master 17'), false);
  assert.equal(looksLikeVrm('2018 qashqai'), false);
  assert.equal(looksLikeVrm('BMW 320i M Sport auto 1998cc'), false);
});

test('a real plate still gets through, however the customer typed it', () => {
  // Plates from this garage's own conversations, including the two that booked.
  assert.equal(looksLikeVrm('WM19 HZJ'), true);
  assert.equal(looksLikeVrm('sg17vly'), true);
  assert.equal(looksLikeVrm('NA14EWE'), true);
  assert.equal(looksLikeVrm('L88 DMS'), true);
  assert.equal(looksLikeVrm('re20 ust'), true);
  assert.equal(looksLikeVrm('CV57KUK'), true);
  assert.equal(looksLikeVrm('YT64 EDV'), true);
  // Dateless and private plates are shorter but still plates.
  assert.equal(looksLikeVrm('A1'), true);
  assert.equal(looksLikeVrm('K9 DAN'), true);
});

test('words with no digits, and digits with no letters, are not plates', () => {
  assert.equal(looksLikeVrm('MOT'), false);
  assert.equal(looksLikeVrm('service'), false);
  assert.equal(looksLikeVrm('07428245673'), false);
  assert.equal(looksLikeVrm(''), false);
});

// ---------------------------------------------------------------------------
// Drop-off slots ARE bookable (fault A)
//
// The write guard assumed a drop-off token was "a guaranteed 400" on
// POST /v1/bookings and bailed before sending, so EVERY booking on a
// drop-off-only service died at the last step — after we had the customer's
// name, plate, email and an explicit yes.
//
// Measured against the live Partner API on 2026-10-21, EAC Telford, Full
// Service (120), Mon 2 Nov: posting {"date":"2026-11-02","time":"AM_DROP_OFF"}
// was ACCEPTED and came back reference 8pOZ81y3qn, status scheduled, with
// Bookar resolving the token itself into appointment 08:00:00 → 09:15:00.
// Bookar wants the token exactly as availability gave it. The guard was wrong.
//
// Heidi Musgrave's conversation on 21 Oct is the one this was reconstructed
// from: two failed create attempts, then "You're all set for the Major Service
// on Monday, the 2nd of November" — a booking that did not exist.
// ---------------------------------------------------------------------------

test('a resolved drop-off reads back as a real time, not as a token', () => {
  // Bookar turns the token into a clock time on the way in. The customer must
  // hear that time — "that morning" is what we said to Heidi, and it left her
  // asking twice whether the car would be there all day.
  assert.equal(
    describeAppointment(
      { date: '2026-11-02', time: 'AM_DROP_OFF' },
      { date: '2026-11-02', time: '08:00:00', start: '2026-11-02T08:00:00+00:00', end: '2026-11-02T09:15:00+00:00' },
    ),
    '2026-11-02, drop off from 08:00 (ready by 09:15)',
  );
});

test('a drop-off with no resolved time never invents one', () => {
  assert.equal(
    describeAppointment({ date: '2026-11-02', time: 'AM_DROP_OFF' }, undefined),
    '2026-11-02, drop off that morning',
  );
});

test('an ordinary timed slot is unchanged', () => {
  assert.equal(
    describeAppointment({ date: '2026-11-02', time: '14:30:00' }, { date: '2026-11-02', time: '14:30:00' }),
    '2026-11-02 at 14:30',
  );
});

// ---------------------------------------------------------------------------
// A failed booking is not retryable and not silent (fault B)
//
// The agent called bk_create_booking, got dropoff_slot_not_bookable, was told
// "Do NOT retry bk_create_booking" in the result itself — and retried 15
// seconds later. Then it told the customer she was all set. needsAttention
// stayed false, so nothing was flagged to the garage either.
//
// A directive the model can read is a directive the model can ignore. The
// second attempt has to be refused in code.
// ---------------------------------------------------------------------------

test('a second create attempt is refused after the API rejected the first', () => {
  assert.equal(nextBookingAttemptAllowed({ bookingFailed: true, bookingConfirmed: false }), false);
});

test('a first attempt, and an untouched session, are allowed', () => {
  assert.equal(nextBookingAttemptAllowed({ bookingConfirmed: false }), true);
  assert.equal(nextBookingAttemptAllowed({ bookingFailed: false, bookingConfirmed: false }), true);
});

test('a booking that succeeded blocks another create too', () => {
  // Already guarded by a prompt line; make it structural so one conversation
  // cannot produce two bookings for the same customer.
  assert.equal(nextBookingAttemptAllowed({ bookingConfirmed: true }), false);
});

// ---------------------------------------------------------------------------
// The heading is named on drop-off days too (fault C)
//
// bk_list_availability's normal return carries `booking_for` plus "that is the
// heading this booking will carry ... Never read back a service you have not
// actually checked availability for". The drop-off branch returned early and
// carried NEITHER.
//
// So when Heidi asked for a "major service", the agent matched it to Full
// Service (120) silently and quoted £306.17 as though that were her job.
// ---------------------------------------------------------------------------

test('the drop-off directive still names the heading being booked', () => {
  const d = dropOffDirective('AM_DROP_OFF', 'Full Service');
  assert.match(d, /Full Service/);
  assert.match(d, /drop-off/i);
  // The token must never be read back as a clock time.
  assert.match(d, /never/i);
});

test('the drop-off directive holds up with no heading resolved', () => {
  const d = dropOffDirective('AM_DROP_OFF', '');
  assert.match(d, /drop-off/i);
  assert.doesNotMatch(d, /undefined/);
});
