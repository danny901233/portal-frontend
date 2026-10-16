// The Bookar diary's lead time comes from BOOKAR, and that change made today bookable.
//
// This adapter used to start at tomorrow (`LEAD_DAYS = 1`, "Bookar will not take a booking for
// today"), which is false: LP Autos' Bookar branch record says `lead_time_days: 0` and their
// diary returns same-day slots. Now that today is offered, today's dead morning comes back with
// everything else — so the slot filter below is the only thing standing between a customer and
// being offered 08:30 at four in the afternoon.
import assert from 'node:assert/strict';
import test from 'node:test';

import { isSlotStillAhead } from './bookar.js';

// 2026-10-16 is a Thursday in BST (UTC+1), so 14:00 UTC is 15:00 in London. Picking a date
// inside British Summer Time is the point: the box runs UTC, the diary is kept in London time,
// and comparing the two naively is how a whole afternoon goes missing.
const BST_AFTERNOON = new Date('2026-10-16T14:00:00Z'); // 15:00 London

test('a slot later today is still offered', () => {
  assert.equal(isSlotStillAhead('2026-10-16', '16:30', BST_AFTERNOON), true);
});

test("today's dead morning is dropped", () => {
  assert.equal(isSlotStillAhead('2026-10-16', '08:30', BST_AFTERNOON), false);
});

test('the comparison is made in London time, not UTC', () => {
  // 14:30 is in the past in London (15:00) but the future by the UTC clock (14:00). Reading the
  // box clock would offer it.
  assert.equal(isSlotStillAhead('2026-10-16', '14:30', BST_AFTERNOON), false);
});

test('a future day is offered whatever the time of day', () => {
  assert.equal(isSlotStillAhead('2026-10-17', '08:30', BST_AFTERNOON), true);
});

test('a past day is never offered', () => {
  assert.equal(isSlotStillAhead('2026-10-15', '23:30', BST_AFTERNOON), false);
});

test('a drop-off window is kept — it is a token, not a clock time', () => {
  // EAC Telford's services 2 and 6 answer "AM_DR" for every open day. There is no time to
  // compare, and the garage decides when the car arrives, so it must not be filtered out.
  assert.equal(isSlotStillAhead('2026-10-16', 'AM_DR', BST_AFTERNOON), true);
  assert.equal(isSlotStillAhead('2026-10-16', 'PM_DR', BST_AFTERNOON), true);
});

test('a drop-off window on a past day is still dropped', () => {
  assert.equal(isSlotStillAhead('2026-10-15', 'AM_DR', BST_AFTERNOON), false);
});

test('midwinter works too, when London is UTC', () => {
  const gmt = new Date('2026-01-15T14:00:00Z'); // 14:00 London
  assert.equal(isSlotStillAhead('2026-01-15', '14:30', gmt), true);
  assert.equal(isSlotStillAhead('2026-01-15', '13:30', gmt), false);
});
