import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyDeterministic, isNoReplySender } from './emailClassifier.js';

const base = {
  subject: '',
  bodyText: '',
  contactGarageId: null as string | null,
  headers: {} as Record<string, string>,
};

// The bug this rule exists for: the From address on an Outdoorsy notification
// is the reservation thread, so an auto-ack goes to the renter, not to Outdoorsy.
test('an Outdoorsy reservation notice is never auto-acknowledged', () => {
  const m = classifyDeterministic({
    ...base,
    senderEmail: '16376775-rogpivw2xlzd9lnl-bookings@reply.outdoorsy.co',
    subject: 'Completed: Documents signed for Reservation16376775onOctober 09',
  });
  assert.ok(m, 'expected a deterministic match');
  assert.equal(m.autoAck, false);
  assert.equal(m.aiDraft, false);
  assert.equal(m.rule, 'booking_platform:reply.outdoorsy.co');
});

// The no-reply guard is what SHOULD have caught these and does not — the local
// part carries no marker it reads. Pinned so nobody removes the domain rule on
// the assumption the guard covers it.
test('the no-reply guard does not catch an Outdoorsy reservation address', () => {
  assert.equal(isNoReplySender('16376775-rogpivw2xlzd9lnl-bookings@reply.outdoorsy.co'), false);
});

test('a renter message stays open so somebody answers it', () => {
  const m = classifyDeterministic({
    ...base,
    senderEmail: '16411983-rogpivw2xlzd9lnl-bookings@reply.outdoorsy.co',
    subject: 'Massimo has sent you a new message',
  });
  assert.ok(m);
  assert.equal(m.autoClose, false);
});

test('a failed hire payment stays open too', () => {
  const m = classifyDeterministic({
    ...base,
    senderEmail: '15393960-rogpivw2xlzd9lnl-bookings@reply.outdoorsy.co',
    subject: 'A Scheduled Payment has Failed',
  });
  assert.ok(m);
  assert.equal(m.autoClose, false);
  assert.equal(m.autoAck, false);
});

test('Wheelbase mail is covered by the same rule', () => {
  const m = classifyDeterministic({
    ...base,
    senderEmail: 'bookings@wheelbasepro.com',
    subject: 'Booking confirmed',
  });
  assert.ok(m);
  assert.equal(m.autoAck, false);
  assert.equal(m.rule, 'booking_platform:wheelbasepro.com');
});

// Outdoorsy's marketing mail was already filed as spam on its bulk header.
// The booking rule sits after the bulk rule so that still happens.
test("Outdoorsy's marketing mail still files as spam, not as a booking", () => {
  const m = classifyDeterministic({
    ...base,
    senderEmail: 'hello@mail.outdoorsy.com',
    subject: 'October hits different in an RV',
    headers: { 'list-unsubscribe': '<https://outdoorsy.com/unsub>' },
  });
  assert.ok(m);
  assert.equal(m.category, 'spam');
  assert.equal(m.autoAck, false);
});

// Guard the ordering from the other side: a supplier must not be reclassified.
test('a Stripe receipt is still supplier billing', () => {
  const m = classifyDeterministic({
    ...base,
    senderEmail: 'invoice+statements@stripe.com',
    subject: 'Your receipt from Eleven Labs Inc.',
  });
  assert.ok(m);
  assert.equal(m.category, 'billing');
  assert.equal(m.autoAck, false);
});

// A real customer must be untouched by all of the above.
test('a garage writing in is left for the normal flow', () => {
  const m = classifyDeterministic({
    ...base,
    senderEmail: 'info@somegarage.co.uk',
    subject: 'Can you change my opening hours?',
    bodyText: 'We now close at 5 on Saturdays.',
  });
  assert.equal(m, null);
});
