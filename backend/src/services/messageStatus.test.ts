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
