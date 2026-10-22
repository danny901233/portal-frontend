import { test } from 'node:test';
import assert from 'node:assert/strict';

import { autoAckOverBudget, ACK_MAX_PER_HOUR, ACK_MAX_PER_DAY } from './autoAckBudget.js';

const now = new Date('2026-10-22T12:00:00Z');
const minutesAgo = (n: number) => new Date(now.getTime() - n * 60_000);
const hoursAgo = (n: number) => new Date(now.getTime() - n * 3_600_000);

test('the first acknowledgement to a sender always goes', () => {
  assert.equal(autoAckOverBudget([], now), null);
});

test('a few separate emails in a day are all acknowledged', () => {
  assert.equal(autoAckOverBudget([hoursAgo(9), hoursAgo(5)], now), null);
});

// The shape of the Torque GT loop: one every eight seconds.
test('a loop is cut off within the hour', () => {
  const loop = [minutesAgo(2), minutesAgo(1.9), minutesAgo(1.8)];
  assert.equal(loop.length, ACK_MAX_PER_HOUR);
  assert.equal(autoAckOverBudget(loop, now), '3/hour');
});

test('the hourly window rolls, so the sender is not locked out for good', () => {
  const loop = [minutesAgo(70), minutesAgo(69), minutesAgo(68)];
  assert.equal(autoAckOverBudget(loop, now), null);
});

// Which is why the hourly cap alone is not enough: three an hour, all night.
test('the daily cap stops an hourly trickle adding up', () => {
  const trickle = [hoursAgo(5), hoursAgo(4), hoursAgo(3), hoursAgo(2), minutesAgo(90)];
  assert.equal(trickle.length, ACK_MAX_PER_DAY);
  assert.equal(autoAckOverBudget(trickle, now), '5/day');
});

test('yesterday does not count against today', () => {
  const yesterday = [hoursAgo(30), hoursAgo(28), hoursAgo(26), hoursAgo(25), hoursAgo(24.5)];
  assert.equal(autoAckOverBudget(yesterday, now), null);
});
