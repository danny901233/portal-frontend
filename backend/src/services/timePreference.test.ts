import { test } from 'node:test';
import assert from 'node:assert/strict';

import { preferredTimeFromMessage, timePreferenceForMatching } from './timePreference.js';

// ── What counts as a time the customer asked for ──

test('a time with a meridiem is a time', () => {
  assert.equal(preferredTimeFromMessage('can I come at 5pm'), '17:00');
});

test('a bare hour after a qualifier is a time', () => {
  assert.equal(preferredTimeFromMessage('anything after 5 please'), '17:00');
});

test('"past 3pm" is a time', () => {
  assert.equal(preferredTimeFromMessage('past 3pm would suit'), '15:00');
});

test('a clock time with minutes is a time', () => {
  assert.equal(preferredTimeFromMessage('9:30 works for me'), '9:30');
});

test('a period word is a time preference', () => {
  assert.equal(preferredTimeFromMessage('morning would be better'), 'morning');
});

test('an afternoon preference is kept', () => {
  assert.equal(preferredTimeFromMessage('Friday afternoon please'), 'afternoon');
});

// Speedy Spanners, 19 Oct 2026 (conversation cmvfkwuwu04ixvx116nulnnab). The "2" of Laura's house
// number was stored as 2pm, and every date she then named was rewritten as "past 2pm" — which a
// drop-off diary offering only 08:30 can never satisfy, so the booking never happened.
test('a house number in an address is not a time', () => {
  assert.equal(
    preferredTimeFromMessage('Can you collect from 2 Yoells Crescent PO8 9SH please'),
    undefined,
  );
});

test('an ordinal date is not a time', () => {
  assert.equal(preferredTimeFromMessage('can I book for 2nd November please'), undefined);
});

test('a full first message with a date, a reg and an address yields no time', () => {
  assert.equal(
    preferredTimeFromMessage(
      'Can I please book for an MOT and service for 2nd November please. Reg P25LAL. '
      + 'Can you please collect and drop off to my home address please? 2 Yoells Crescent PO8 9SH.',
    ),
    undefined,
  );
});

test('a postcode digit is not a time', () => {
  assert.equal(preferredTimeFromMessage('my postcode is PO8 9SH'), undefined);
});

test('a phone number is not a time', () => {
  assert.equal(preferredTimeFromMessage('my number is 07787403730'), undefined);
});

test('a mileage is not a time', () => {
  assert.equal(preferredTimeFromMessage('it has done 54 thousand miles'), undefined);
});

test('a day on its own is not a time', () => {
  assert.equal(preferredTimeFromMessage('Monday please'), undefined);
});

test('"at 9" is nine in the morning', () => {
  assert.equal(preferredTimeFromMessage('could I drop it at 9'), '9:00');
});

// ── Carrying a saved time onto a new date ──

test('a saved time is carried onto a day-only preference', () => {
  assert.equal(
    timePreferenceForMatching('Monday instead', '17:00', false),
    'Monday instead past 5pm',
  );
});

test('a period word is appended as itself', () => {
  assert.equal(timePreferenceForMatching('Tuesday', 'morning', false), 'Tuesday morning');
});

test('a preference that already names a time is left alone', () => {
  assert.equal(timePreferenceForMatching('Monday at 4pm', '17:00', false), 'Monday at 4pm');
});

// A drop-off garage has one slot a day and no time to choose, so carrying a time forward can only
// make a date the diary HAS look unavailable.
test('nothing is carried forward at a drop-off garage', () => {
  assert.equal(timePreferenceForMatching('2nd November', '14:00', true), '2nd November');
});

test('with no saved time the preference is unchanged', () => {
  assert.equal(timePreferenceForMatching('2nd November', undefined, false), '2nd November');
});
