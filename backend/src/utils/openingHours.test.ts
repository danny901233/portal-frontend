import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isWithinOpeningHours } from './openingHours.js';

const closedAllWeek = {
  monday: { open: null, close: null, closed: true },
  tuesday: { open: null, close: null, closed: true },
  wednesday: { open: null, close: null, closed: true },
  thursday: { open: null, close: null, closed: true },
  friday: { open: null, close: null, closed: true },
  saturday: { open: null, close: null, closed: true },
  sunday: { open: null, close: null, closed: true },
};

const nineToFive = {
  ...closedAllWeek,
  wednesday: { open: '09:00', close: '17:00', closed: false },
};

// 2026-10-14 is a Wednesday, and Britain is on BST, so 12:00Z is 13:00 local. Every fixture
// below was checked against Europe/London rather than assumed.
const wedMidday = new Date('2026-10-14T12:00:00Z');        // Wed 13:00
const wedLateEvening = new Date('2026-10-14T20:30:00Z');   // Wed 21:30
const wedBeforeOpen = new Date('2026-10-14T06:00:00Z');    // Wed 07:00

test('open inside the configured window', () => {
  assert.equal(isWithinOpeningHours(nineToFive, wedMidday), true);
});

test('closed after the close time', () => {
  assert.equal(isWithinOpeningHours(nineToFive, wedLateEvening), false);
});

test('closed before the open time', () => {
  assert.equal(isWithinOpeningHours(nineToFive, wedBeforeOpen), false);
});

test('a day marked closed is closed even with times set', () => {
  const hours = { ...nineToFive, wednesday: { open: '09:00', close: '17:00', closed: true } };
  assert.equal(isWithinOpeningHours(hours, wedMidday), false);
});

// Review Focus 4. Unknown hours must never read as "always open" — that rings customers at 3am.
test('null hours are treated as closed', () => {
  assert.equal(isWithinOpeningHours(null, wedMidday), false);
});

test('malformed hours are treated as closed', () => {
  assert.equal(isWithinOpeningHours({ wednesday: 'all day' }, wedMidday), false);
  assert.equal(
    isWithinOpeningHours({ wednesday: { open: 'morning', close: '17:00', closed: false } }, wedMidday),
    false,
  );
  assert.equal(isWithinOpeningHours('open', wedMidday), false);
  assert.equal(isWithinOpeningHours([], wedMidday), false);
});

test('the clock is read in Europe/London, not UTC', () => {
  // 16:30Z in October is 17:30 BST — past a 17:00 close, though still before it in UTC.
  assert.equal(isWithinOpeningHours(nineToFive, new Date('2026-10-14T16:30:00Z')), false);
});

test('a close time before the open time is treated as closed', () => {
  const hours = { ...closedAllWeek, wednesday: { open: '17:00', close: '09:00', closed: false } };
  assert.equal(isWithinOpeningHours(hours, wedMidday), false);
});
