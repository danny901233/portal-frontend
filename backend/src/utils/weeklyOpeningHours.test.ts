import { test } from 'node:test';
import assert from 'node:assert/strict';

import { weeklyOpeningHoursSchema } from './validators.js';

/**
 * Bee Cool ACS, 28 Oct 2026. David emailed: "I have tried to update our opening hours to close
 * daily at 5.30 and closed on Saturdays, but the portal will not accept these changes."
 *
 * He was right, and it was not his doing. The Closed tickbox in HoursTab only ever flipped
 * `closed`, leaving the day's previous open/close in state, and the time inputs are hidden once
 * a day reads Closed — so a closed Saturday reached this schema as
 * { open: '09:30', close: '13:30', closed: true } and came back "Clear the opening time when the
 * day is marked closed", with no way to clear it from the UI.
 *
 * One bad day fails the whole form, so his 17:30 weekday change went down with it. The audit log
 * shows seven config saves from him between 17:27 and 17:44 on 27 Oct and no weeklyOpeningHours
 * entry at all — it never got past validation.
 */

const OPEN = (open: string, close: string) => ({ open, close, closed: false });
const SHUT = { open: null, close: null, closed: true };

const parse = (val: unknown) => weeklyOpeningHoursSchema.safeParse(val);

/** Bee Cool's stored hours, with David's two edits applied the way the UI applied them. */
const DAVIDS_PAYLOAD = {
  monday: OPEN('08:30', '17:30'),
  tuesday: OPEN('08:30', '17:30'),
  wednesday: OPEN('08:30', '17:30'),
  thursday: OPEN('08:30', '17:30'),
  friday: OPEN('08:30', '17:30'),
  // Ticked Closed. The old times stayed behind — this is the whole bug.
  saturday: { open: '09:30', close: '13:30', closed: true },
  sunday: SHUT,
};

test('a day ticked Closed saves, even with its old times still attached', () => {
  const res = parse(DAVIDS_PAYLOAD);
  assert.equal(res.success, true, 'David\'s payload must be accepted');
  assert.deepEqual(res.data!.saturday, SHUT, 'the stale Saturday times must be dropped');
});

test('the weekday change survives — one closed day no longer fails the whole form', () => {
  const res = parse(DAVIDS_PAYLOAD);
  assert.equal(res.success, true);
  assert.equal(res.data!.monday.close, '17:30');
  assert.equal(res.data!.friday.close, '17:30');
});

test('the old HoursTab Sunday default is accepted instead of rejecting the save', () => {
  // defaultHours() seeded sunday as 00:00/00:00 closed:true, which violated the refinement.
  // Any garage that opened this tab and saved without touching Sunday was turned away.
  const res = parse({
    monday: OPEN('08:30', '18:00'),
    tuesday: OPEN('08:30', '18:00'),
    wednesday: OPEN('08:30', '18:00'),
    thursday: OPEN('08:30', '18:00'),
    friday: OPEN('08:30', '18:00'),
    saturday: OPEN('09:00', '13:00'),
    sunday: { open: '00:00', close: '00:00', closed: true },
  });
  assert.equal(res.success, true);
  assert.deepEqual(res.data!.sunday, SHUT);
});

test('an open day is passed through untouched', () => {
  const res = parse({
    monday: OPEN('08:30', '17:00'),
    tuesday: OPEN('08:30', '17:00'),
    wednesday: OPEN('08:30', '17:00'),
    thursday: OPEN('08:30', '17:00'),
    friday: OPEN('08:30', '17:00'),
    saturday: OPEN('09:30', '13:30'),
    sunday: SHUT,
  });
  assert.equal(res.success, true);
  assert.deepEqual(res.data!.saturday, OPEN('09:30', '13:30'));
  assert.deepEqual(res.data!.monday, OPEN('08:30', '17:00'));
});

test('an open day with no times is still rejected, and says which field', () => {
  // The permissive half must not swallow a real mistake.
  const res = parse({
    monday: { open: null, close: null, closed: false },
    tuesday: OPEN('08:30', '17:00'),
    wednesday: OPEN('08:30', '17:00'),
    thursday: OPEN('08:30', '17:00'),
    friday: OPEN('08:30', '17:00'),
    saturday: SHUT,
    sunday: SHUT,
  });
  assert.equal(res.success, false);
  const paths = res.error!.issues.map((i) => i.path.join('.'));
  assert.ok(paths.includes('monday.open'), `expected monday.open, got ${paths.join(', ')}`);
});

test('an empty time input reads as missing, not as a malformed time', () => {
  // An emptied <input type="time"> posts "". Before, that tripped the HH:MM regex and the
  // garage was told to "Use HH:MM in 24-hour time" about a box they had just cleared.
  const res = parse({
    monday: { open: '', close: '', closed: false },
    tuesday: OPEN('08:30', '17:00'),
    wednesday: OPEN('08:30', '17:00'),
    thursday: OPEN('08:30', '17:00'),
    friday: OPEN('08:30', '17:00'),
    saturday: SHUT,
    sunday: SHUT,
  });
  assert.equal(res.success, false);
  const messages = res.error!.issues.map((i) => i.message);
  assert.ok(
    messages.some((m) => m.includes('Opening time is required')),
    `expected the required message, got: ${messages.join(' | ')}`,
  );
  assert.ok(
    !messages.some((m) => m.includes('24-hour time')),
    'an emptied box should not be reported as a badly formatted time',
  );
});

test('a genuinely malformed time is still caught', () => {
  const res = parse({
    monday: { open: '25:00', close: '17:00', closed: false },
    tuesday: OPEN('08:30', '17:00'),
    wednesday: OPEN('08:30', '17:00'),
    thursday: OPEN('08:30', '17:00'),
    friday: OPEN('08:30', '17:00'),
    saturday: SHUT,
    sunday: SHUT,
  });
  assert.equal(res.success, false);
  assert.ok(res.error!.issues.some((i) => i.message.includes('24-hour time')));
});

test('a missing day is filled in as closed, as it was before', () => {
  const res = parse({ monday: OPEN('08:30', '17:00') });
  assert.equal(res.success, true);
  assert.deepEqual(res.data!.sunday, SHUT);
  assert.deepEqual(res.data!.saturday, SHUT);
  assert.deepEqual(res.data!.monday, OPEN('08:30', '17:00'));
});

test('every day closed is a valid week', () => {
  const res = parse({
    monday: SHUT, tuesday: SHUT, wednesday: SHUT, thursday: SHUT,
    friday: SHUT, saturday: SHUT, sunday: SHUT,
  });
  assert.equal(res.success, true);
});

test('a non-object is left for the schema to reject, not coerced', () => {
  assert.equal(parse(null).success, false);
  assert.equal(parse('monday').success, false);
});
