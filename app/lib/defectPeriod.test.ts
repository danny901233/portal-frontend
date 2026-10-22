/**
 * The time window behind the Call faults filter.
 *
 * Dan, 22 Oct 2026: "the table should be able to be filtered, rather than it deep MOST RECENT,
 * we should be able to filter by day, month, etc".
 *
 * Month and day boundaries are the easy thing to get subtly wrong, so the arithmetic lives here
 * on its own rather than inline in the dashboard.
 *
 *   npx tsx --test app/lib/defectPeriod.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFECT_PERIODS, defectRange } from './defectPeriod.js';

// A Thursday lunchtime, mid-month, so day and month edges are both visible.
const NOW = new Date('2026-10-22T12:30:00.000Z');

// Boundaries are LOCAL — "today" means the viewer's today, not UTC's — so these
// assert local date parts rather than ISO strings, which would only pass in UTC.
const isLocalMidnight = (d: Date) =>
  d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0;
const sameLocalDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

test('today starts at local midnight and ends now', () => {
  const [start, end] = defectRange('today', NOW);
  assert.ok(isLocalMidnight(start), 'must start at midnight where the viewer is');
  assert.ok(sameLocalDay(start, NOW), 'and on their today');
  assert.equal(end.toISOString(), NOW.toISOString());
});

test('yesterday is the whole of the previous day and stops at midnight', () => {
  const [start, end] = defectRange('yesterday', NOW);
  assert.ok(isLocalMidnight(start) && isLocalMidnight(end));
  const expected = new Date(NOW);
  expected.setDate(expected.getDate() - 1);
  assert.ok(sameLocalDay(start, expected));
  assert.ok(sameLocalDay(end, NOW), 'it ends where today begins');
  assert.equal(end.getTime() - start.getTime(), 24 * 3600 * 1000);
});

test('this month starts on the 1st, not 30 days ago', () => {
  const [start, end] = defectRange('month', NOW);
  assert.ok(isLocalMidnight(start));
  assert.equal(start.getDate(), 1);
  assert.equal(start.getMonth(), NOW.getMonth());
  assert.equal(start.getFullYear(), NOW.getFullYear());
  assert.equal(end.toISOString(), NOW.toISOString());
});

test('last month is the whole of it and stops where this month starts', () => {
  const [start, end] = defectRange('lastMonth', NOW);
  assert.ok(isLocalMidnight(start) && isLocalMidnight(end));
  assert.equal(start.getDate(), 1);
  assert.equal(end.getDate(), 1);
  assert.equal(end.getMonth(), NOW.getMonth(), 'ends at the start of this month');
  const expectedMonth = (NOW.getMonth() + 11) % 12;
  assert.equal(start.getMonth(), expectedMonth);
});

test('last month crosses the year boundary correctly', () => {
  const jan = new Date('2027-01-09T09:00:00.000Z');
  const [start, end] = defectRange('lastMonth', jan);
  assert.equal(start.getMonth(), 11, 'December');
  assert.equal(start.getFullYear(), 2026);
  assert.equal(end.getMonth(), 0, 'January');
  assert.equal(end.getFullYear(), 2027);
});

test('7 days reaches back a week from now', () => {
  const [start, end] = defectRange('7d', NOW);
  assert.equal(start.toISOString(), '2026-10-15T12:30:00.000Z');
  assert.equal(end.toISOString(), NOW.toISOString());
});

test('30 days reaches back a month from now', () => {
  const [start] = defectRange('30d', NOW);
  assert.equal(start.toISOString(), '2026-09-22T12:30:00.000Z');
});

test('this month on the 1st is still that day, not an empty window', () => {
  const first = new Date('2026-11-01T08:15:00.000Z');
  const [start, end] = defectRange('month', first);
  assert.equal(start.getDate(), 1);
  assert.ok(end > start, 'a window that starts after it ends would show nothing');
});

test('all reaches back far enough to cover every call we have', () => {
  const [start, end] = defectRange('all', NOW);
  assert.ok(start < new Date('2026-01-01T00:00:00.000Z'), 'must predate the first calls');
  assert.equal(end.toISOString(), NOW.toISOString());
});

test('an unknown period falls back to a window, never an empty one', () => {
  const [start, end] = defectRange('nonsense' as never, NOW);
  assert.ok(start < end);
});

test('every period offered has a label and a working range', () => {
  for (const { value, label } of DEFECT_PERIODS) {
    assert.ok(label.length > 0, `${value} needs a label`);
    const [start, end] = defectRange(value, NOW);
    assert.ok(start instanceof Date && end instanceof Date, `${value} must give two dates`);
    assert.ok(start < end, `${value} produced a backwards window`);
  }
});
