import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isDueForSummary, describeConversation, summaryDelivery } from './chatSummaryDigest.js';

const now = new Date('2026-10-19T14:00:00Z');
const due = {
  lastMessageAt: new Date('2026-10-19T13:40:00Z'), // 20 minutes quiet
  summaryEmailSentAt: null as Date | null,
  userMessages: 4,
  startAt: new Date('2026-10-19T00:00:00Z'),
};

test('a conversation quiet for longer than the idle window is due', () => {
  assert.equal(isDueForSummary(due, now), true);
});

// The customer may still be typing. A summary sent mid-conversation is both wrong and a second
// email away from being ignored.
test('a conversation still in progress is not due', () => {
  assert.equal(
    isDueForSummary({ ...due, lastMessageAt: new Date('2026-10-19T13:58:00Z') }, now),
    false,
  );
});

test('a conversation already summarised is not due again', () => {
  assert.equal(
    isDueForSummary({ ...due, summaryEmailSentAt: new Date('2026-10-19T13:45:00Z') }, now),
    false,
  );
});

// Nobody needs an email about a widget somebody opened and closed.
test('a conversation the customer never wrote in is not due', () => {
  assert.equal(isDueForSummary({ ...due, userMessages: 0 }, now), false);
});

// The sweep must never email the back catalogue the first time it runs.
test('a conversation older than the rollout is not due', () => {
  assert.equal(
    isDueForSummary({ ...due, startAt: new Date('2026-10-19T13:50:00Z') }, now),
    false,
  );
});

test('a conversation quiet for days is not due', () => {
  assert.equal(
    isDueForSummary({
      ...due,
      lastMessageAt: new Date('2026-10-16T09:00:00Z'),
      startAt: new Date('2026-10-01T00:00:00Z'),
    }, now),
    false,
  );
});

// ── The fallback description, used when the one-line AI summary is unavailable ──

test('a booking is described with the service and when', () => {
  assert.equal(
    describeConversation({
      customerName: 'Katherine',
      confirmedBooking: true,
      bookingDetails: 'Full Service on 2026-12-11 at 08:30',
      session: { vehicleMake: 'Ford', vehicleModel: 'Kuga', vrn: 'YA73WKB' },
      firstUserMessage: 'how much is a service',
      needsAttention: false,
    }),
    'Katherine booked Full Service on 2026-12-11 at 08:30 for their Ford Kuga (YA73WKB).',
  );
});

test('a conversation needing a human says so, with what they wanted', () => {
  assert.equal(
    describeConversation({
      customerName: 'Aliciyurr',
      confirmedBooking: false,
      bookingDetails: null,
      session: { message: 'Wants prices by email for a clutch replacement' },
      firstUserMessage: 'I have a clutch judder when in first gear',
      needsAttention: true,
    }),
    'Aliciyurr needs a reply: Wants prices by email for a clutch replacement',
  );
});

test('an enquiry that went nowhere quotes what they asked', () => {
  assert.equal(
    describeConversation({
      customerName: null,
      confirmedBooking: false,
      bookingDetails: null,
      session: {},
      firstUserMessage: 'Do you do air conditioning regas?',
      needsAttention: false,
    }),
    'A customer asked: "Do you do air conditioning regas?" No booking was made.',
  );
});

test('a long opening message is trimmed', () => {
  const out = describeConversation({
    customerName: null,
    confirmedBooking: false,
    bookingDetails: null,
    session: {},
    firstUserMessage: 'x'.repeat(400),
    needsAttention: false,
  });
  assert.ok(out.length < 250, `too long: ${out.length}`);
  assert.ok(out.includes('…'));
});

// ── Who may be sent the conversation itself ──
//
// Matches the call side (routes/calls.ts): an account in arrears is told a conversation was
// handled and nothing about what was said, until it is brought up to date.

test('an ordinary garage gets the summary', () => {
  assert.equal(summaryDelivery({ accessRestricted: false, paymentFailedAt: null, archivedAt: null }), 'summary');
});

test('a garage flagged in arrears gets the notice, not the content', () => {
  assert.equal(summaryDelivery({ accessRestricted: true, paymentFailedAt: null, archivedAt: null }), 'arrears-notice');
});

test('a failed payment past the grace window withholds the content', () => {
  assert.equal(
    summaryDelivery(
      { accessRestricted: false, paymentFailedAt: new Date('2026-10-10T00:00:00Z'), archivedAt: null },
      new Date('2026-10-19T14:00:00Z'),
    ),
    'arrears-notice',
  );
});

test('a failed payment inside the grace window still gets the summary', () => {
  assert.equal(
    summaryDelivery(
      { accessRestricted: false, paymentFailedAt: new Date('2026-10-19T08:00:00Z'), archivedAt: null },
      new Date('2026-10-19T14:00:00Z'),
    ),
    'summary',
  );
});

test('an archived garage is emailed nothing', () => {
  assert.equal(
    summaryDelivery({ accessRestricted: false, paymentFailedAt: null, archivedAt: new Date('2026-10-01T00:00:00Z') }),
    'skip',
  );
});
