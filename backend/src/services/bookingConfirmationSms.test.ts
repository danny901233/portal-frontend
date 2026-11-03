import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildBody, formatWhen } from './bookingConfirmationSms.js';

/**
 * receptionmate-agents#38 — the confirmation text the agent has been promising.
 *
 * `enableSmsBookingLinks` was on for 41 of 69 garages, the prompt told the caller it was "sent
 * automatically", and `SmsBookingLink` had zero rows all time. 438 calls in 90 days were told a
 * text was coming. Eight callers rang back to ask where it was — the clearest pair being
 * In'n'out Spalding 57797331 (20 Oct, £317 service and MOT) and 30367760 the next day from the
 * same number: "I rang up yesterday to book a service, and I haven't received my confirmation."
 *
 * These tests cover the wording and the refusals. The Twilio call itself is not exercised —
 * that needs credentials and would send a real text — so `sendBookingConfirmationSms` is
 * deliberately split so the part worth asserting has no network in it.
 */

const BASE = {
  garageId: 'g1',
  garageName: 'Bee Cool ACS',
  garagePhone: '01536 123456',
  customerPhone: '+447700900123',
  registrationNumber: 'st63zlx',
  bookingAt: new Date('2026-10-30T09:00:00Z'),
  smsEnabled: true,
};

test('the message says where, when and which car', () => {
  const body = buildBody(BASE);
  assert.ok(body);
  assert.match(body!, /Bee Cool ACS/);
  assert.match(body!, /Fri 30 Oct/);
  assert.match(body!, /9:00am/);
  assert.match(body!, /ST63ZLX/, 'the plate reads back in caps, as a plate');
});

test('it tells them how to reach a human, because they cannot reply to it', () => {
  // SMS_FROM is an alphanumeric sender ID ("ReceptMate"), so the recipient has no number to
  // reply to. A confirmation they cannot answer has to carry the garage's own phone number.
  const body = buildBody(BASE)!;
  assert.match(body, /call 01536 123456/);
});

test('no appointment time means no text at all', () => {
  // Worse than silence: it tells someone a booking exists without saying when, and they cannot
  // reply to ask.
  assert.equal(buildBody({ ...BASE, bookingAt: null }), null);
});

test('a missing plate or garage number just drops that clause', () => {
  const noReg = buildBody({ ...BASE, registrationNumber: null })!;
  assert.doesNotMatch(noReg, /Vehicle:/);
  assert.match(noReg, /confirmed for/);

  const noPhone = buildBody({ ...BASE, garagePhone: null })!;
  assert.doesNotMatch(noPhone, /call/);
  assert.match(noPhone, /confirmed for/);
});

test('it stays inside one SMS segment on a realistic booking', () => {
  // Over 160 GSM-7 characters Twilio bills a second segment, and the £0.99 row would then
  // understate what the garage was charged.
  const body = buildBody({ ...BASE, garageName: 'Advanced Service Centre Ltd' })!;
  assert.ok(body.length <= 160, `body is ${body.length} chars:\n${body}`);
});


// ── times, which are the thing most likely to be quietly wrong ──────────

test('times render in London time, not UTC', () => {
  // 2026-07-30 is BST, so 09:00Z is 10:00 local. Sending someone to the garage an hour early
  // is exactly the class of error #16 was filed for.
  assert.match(formatWhen(new Date('2026-07-30T09:00:00Z')), /10:00am/);
  // And in GMT the two agree.
  assert.match(formatWhen(new Date('2026-11-30T09:00:00Z')), /9:00am/);
});

test('midnight and noon do not come out as 0 or 12 the wrong way round', () => {
  assert.match(formatWhen(new Date('2026-11-30T12:00:00Z')), /12:00pm/);
  assert.match(formatWhen(new Date('2026-11-30T00:30:00Z')), /12:30am/);
});

test('the weekday matches the date', () => {
  // 30 Oct 2026 is a Friday. A confirmation naming the wrong day is wrong information.
  assert.match(formatWhen(new Date('2026-10-30T09:00:00Z')), /^Fri 30 Oct/);
});
