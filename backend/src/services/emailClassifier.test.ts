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

// ─── Auto-responders (the Torque GT loop, 2026-10-22) ──────────────────────
// Their Zendesk acknowledged a message sent from hello@; we acknowledged the
// acknowledgement; it acknowledged ours. 15 round trips in two minutes, each
// one a new ticket, until the sender was blocked by hand.

test('a Zendesk auto-acknowledgement is never acknowledged back', () => {
  const m = classifyDeterministic({
    ...base,
    senderEmail: 'support@torquegt.zendesk.com',
    subject: '[Request received] - Torque GT',
    bodyText: '##- Please type your reply above this line -##\n\nThanks for the message.',
    headers: {
      'auto-submitted': 'auto-generated',
      'x-auto-response-suppress': 'All',
      'x-mailer': 'Zendesk Mailer',
    },
  });
  assert.ok(m, 'expected a deterministic match');
  assert.equal(m.autoAck, false);
  assert.equal(m.aiDraft, false);
  assert.equal(m.autoClose, true);
  assert.equal(m.rule, 'auto_response:auto-submitted');
});

// The loop is between two robots, and it does not matter whose robot it is.
// The bulk and no-reply rules both exempt a known garage, which is why this
// one must not: a customer's own helpdesk loops exactly like a stranger's.
test('a known garage does not exempt an auto-responder', () => {
  const m = classifyDeterministic({
    ...base,
    senderEmail: 'service@somegarage.co.uk',
    contactGarageId: 'grg_123',
    subject: 'Automatic reply: [RM-2PQQEEZ] Your message',
    headers: { 'auto-submitted': 'auto-replied' },
  });
  assert.ok(m);
  assert.equal(m.autoAck, false);
  assert.equal(m.rule, 'auto_response:auto-submitted');
});

test('X-Auto-Response-Suppress alone is enough', () => {
  const m = classifyDeterministic({
    ...base,
    senderEmail: 'helpdesk@example.com',
    subject: 'Ticket 4471 received',
    headers: { 'x-auto-response-suppress': 'OOF, AutoReply' },
  });
  assert.ok(m);
  assert.equal(m.autoAck, false);
  assert.equal(m.rule, 'auto_response:x-auto-response-suppress');
});

test('Precedence: auto_reply is an auto-responder, not bulk mail', () => {
  const m = classifyDeterministic({
    ...base,
    senderEmail: 'rota@example.com',
    contactGarageId: 'grg_123',
    subject: 'Out of the office',
    headers: { precedence: 'auto_reply' },
  });
  assert.ok(m);
  assert.equal(m.rule, 'auto_response:precedence');
});

// RFC 3834: a human-written message may carry the header with this value, and
// it means the opposite. Reading it as a robot would silence real mail.
test('Auto-Submitted: no is a person, not a robot', () => {
  const m = classifyDeterministic({
    ...base,
    senderEmail: 'info@somegarage.co.uk',
    subject: 'Can you change my opening hours?',
    headers: { 'auto-submitted': 'no' },
  });
  assert.equal(m, null);
});

// Our own M365 rule copies hello@ to Mailgun, and that forward stamps every
// message it touches with a loop counter — including a customer's. Reading it
// as an auto-reply marker would suppress the acknowledgement on all of them.
test('the M365 transport-rule loop header is not an auto-reply marker', () => {
  const m = classifyDeterministic({
    ...base,
    senderEmail: 'info@somegarage.co.uk',
    subject: 'Can you change my opening hours?',
    headers: { 'x-ms-exchange-transport-rules-loop': '1' },
  });
  assert.equal(m, null);
});

// No headers at all, just the subject a mail client writes. Worth suppressing
// the reply for, not worth closing on: "Out of office cover" is a real subject
// a real person could send, and a closed ticket is one nobody looks at.
test('an out-of-office subject suppresses the reply but stays open', () => {
  const m = classifyDeterministic({
    ...base,
    senderEmail: 'manager@somegarage.co.uk',
    contactGarageId: 'grg_123',
    subject: 'Automatic reply: Your message',
  });
  assert.ok(m);
  assert.equal(m.autoAck, false);
  assert.equal(m.aiDraft, false);
  assert.equal(m.autoClose, false);
  assert.equal(m.rule, 'auto_response:subject');
});

// Ordering guard from the other side: a supplier's receipt is auto-generated
// too, and it must keep going to Dan as billing rather than becoming 'other'.
test('a Stripe receipt stays billing even though it is auto-generated', () => {
  const m = classifyDeterministic({
    ...base,
    senderEmail: 'invoice+statements@stripe.com',
    subject: 'Your receipt from Eleven Labs Inc.',
    headers: { 'auto-submitted': 'auto-generated' },
  });
  assert.ok(m);
  assert.equal(m.category, 'billing');
  assert.match(m.rule, /^supplier_domain:stripe\.com/);
});

// ── our own billing alerts must stay in the queue ──────────────────────────
//
// A.M. Engineering's card declined on 16 Oct. The webhook emailed
// hello@receptionmate.co.uk on every Stripe retry — 16, 17, 19, 21 and 23 Oct,
// all five delivered — and every one became a ticket that was CLOSED 16
// milliseconds after it arrived, then archived out of the inbox. Dan never saw
// any of them and asked why he had not been notified. He had been, five times.
//
// Rule 4 files everything our own systems send unless the subject is on
// OURS_WORTH_QUEUEING, which held only the watchdog alerts and the nightly
// report. The comment there says filing an outage on arrival "buries an outage
// in a queue nobody opens" — the same is true of money.
test('a failed card payment stays open in the queue', () => {
  const m = classifyDeterministic({
    senderEmail: 'noreply@receptionmate.co.uk',
    subject: 'Assist payment failed — A.M. Engineering Vehicle Servicing and Repair',
    bodyText: 'Stripe subscription payment failed for A.M. Engineering (invoice in_123).',
    headers: {},
    contactGarageId: null,
  });
  assert.equal(m?.autoClose, false, 'this is the mail most worth seeing');
  assert.equal(m?.rule, 'automated_sender:ours_alert');
});

test('a cancelled subscription stays open too', () => {
  const m = classifyDeterministic({
    senderEmail: 'noreply@receptionmate.co.uk',
    subject: 'Assist subscription cancelled — Some Garage Ltd',
    bodyText: 'Stripe subscription cancelled.',
    headers: {},
    contactGarageId: null,
  });
  assert.equal(m?.autoClose, false);
});

// The allow-list is scoped to our own sending domain, so a customer or a
// supplier cannot hold a ticket open by choosing a subject line.
test('an outsider cannot keep a ticket open with the same subject', () => {
  const m = classifyDeterministic({
    senderEmail: 'noreply@someone-else.com',
    subject: 'Assist payment failed — nice try',
    bodyText: 'x',
    headers: {},
    contactGarageId: null,
  });
  assert.equal(m?.autoClose, true);
  assert.equal(m?.rule, 'automated_sender:external');
});

// And the ordinary per-call notifications we send ourselves must still file,
// or the queue fills with records nobody works.
test('a routine notification from us still files on arrival', () => {
  const m = classifyDeterministic({
    senderEmail: 'noreply@receptionmate.co.uk',
    subject: 'New call for Speedy Spanners',
    bodyText: 'A call was answered.',
    headers: {},
    contactGarageId: null,
  });
  assert.equal(m?.autoClose, true);
  assert.equal(m?.rule, 'automated_sender:ours');
});
