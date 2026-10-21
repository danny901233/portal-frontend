import { test } from 'node:test';
import assert from 'node:assert/strict';

import { statusUpdate, STATUS_RANK } from './messageStatus.js';

const AT = new Date('2026-10-21T20:00:00Z');

// ---------------------------------------------------------------------------
// Delivery receipts for conversation replies
//
// Meta posts sent → delivered → read → failed to the same webhook the outbound campaigns have
// always used, so the plumbing existed; conversation replies simply had nothing to join on
// because no send path kept the wamid it was given.
//
// Worth having beyond the reporting: a `failed` status can arrive AFTER Meta has answered the
// send with 200 OK, which is a failure the send-then-record ordering cannot see at all.
// ---------------------------------------------------------------------------

test('each status moves the message forward', () => {
  assert.deepEqual(statusUpdate(null, 'sent', AT), { deliveryStatus: 'sent' });
  assert.deepEqual(statusUpdate('sent', 'delivered', AT),
    { deliveryStatus: 'delivered', deliveredAt: AT });
  assert.deepEqual(statusUpdate('delivered', 'read', AT),
    { deliveryStatus: 'read', readAt: AT });
});

// Meta does not promise ordering, and retries. A late 'sent' arriving after 'read' must not
// rewind the message to looking undelivered — that would read as a fault where there is none.
test('a status that arrives late never rewinds the message', () => {
  assert.equal(statusUpdate('read', 'delivered', AT), null);
  assert.equal(statusUpdate('read', 'sent', AT), null);
  assert.equal(statusUpdate('delivered', 'sent', AT), null);
  assert.equal(statusUpdate('delivered', 'delivered', AT), null, 'a duplicate is not an update');
});

// A failure is the one thing that must never be masked, whatever arrived before it.
test('failed always wins, and carries the reason', () => {
  const got = statusUpdate('read', 'failed', AT, [{ code: 131026, title: 'Message undeliverable' }]);
  assert.deepEqual(got, {
    deliveryStatus: 'failed',
    failedReason: 'Message undeliverable (131026)',
  });
  assert.ok(STATUS_RANK.failed > STATUS_RANK.read);
});

test('a failure with no error detail still records that it failed', () => {
  assert.deepEqual(statusUpdate('sent', 'failed', AT), {
    deliveryStatus: 'failed',
    failedReason: 'Delivery failed',
  });
});

// Meta adds status values over time; an unknown one must not throw inside a webhook handler or
// we lose the whole batch, including the statuses we do understand.
test('an unrecognised status is ignored rather than thrown', () => {
  assert.equal(statusUpdate('sent', 'warp-speed', AT), null);
  assert.equal(statusUpdate(null, '', AT), null);
});

// A status string arrives from a webhook, so it is attacker-shaped input, and a plain object
// lookup answers for keys the object does not own: STATUS_RANK['constructor'] is the Function
// constructor — truthy — so the guard above let it through and the message was written as 'sent'.
// The "unrecognised status is ignored" test above passed only because 'warp-speed' happens not to
// be on Object.prototype, which is false confidence rather than coverage.
test('a prototype key is not a status', () => {
  for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
    assert.equal(statusUpdate(null, key, AT), null, `${key} must not be treated as a status`);
    assert.equal(statusUpdate('sent', key, AT), null, `${key} must not advance a real status`);
  }
});

test('a prototype key cannot mask a real failure either', () => {
  // The reverse direction: `current` comes from our own column, but if a prototype key ever got
  // written there, ranking against it must not silently discard a genuine incoming failure.
  const got = statusUpdate('constructor', 'failed', AT, [{ code: 131026, title: 'Undeliverable' }]);
  assert.deepEqual(got, { deliveryStatus: 'failed', failedReason: 'Undeliverable (131026)' });
});

// failedReason is Meta's text going into a database column and then onto a page. Cap it.
test('an absurdly long failure reason is truncated', () => {
  const got = statusUpdate('sent', 'failed', AT, [{ code: 1, title: 'x'.repeat(5000) }]);
  assert.ok(got);
  assert.ok(got!.failedReason!.length <= 300, `was ${got!.failedReason!.length}`);
});
