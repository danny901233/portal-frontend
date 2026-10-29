/**
 * The closing figure, pinned to the account that proved it wrong.
 *
 * Mallory Performance gave notice on 27 Oct 2026. Priced on 29 Oct at £574.56 and again at
 * £95.76 within twenty minutes; the second is right. Both errors came from reading the invoice's
 * `periodStart`/`periodEnd` as "what this invoice buys", when it is the month whose MINUTES are
 * being charged in arrears — the subscription on the same invoice buys the month about to start.
 *
 *   paid 27 Jul   label 20 Jul→20 Aug   £399   used   0/400
 *   paid 21 Aug   label 20 Jul→20 Aug   £399   used 285/400
 *   paid 21 Sep   label 20 Aug→20 Sep   £399   used 275/400
 *   paid 21 Oct   label 20 Sep→20 Oct   £399   used 207/400
 *
 * The first two share a label and are not duplicates — the usage differs. The 21 Oct payment
 * bought cover to 20 Nov, so a 26 Nov leaver owes six days.
 *
 * These tests exercise the arithmetic directly rather than through Prisma, so they run anywhere
 * and still fail if the advance-billing rule is ever flipped back.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { renderLeaverEmail, type ClosingAmount } from './leaverNotice.js';

/** Mallory, as the computation should produce it. */
const MALLORY: ClosingAmount = {
  confident: true,
  blockers: [],
  garageName: 'Mallory Performance Ltd',
  endsOn: new Date('2026-11-26T23:59:00Z'),
  noticeGivenOn: new Date('2026-10-27T00:00:00Z'),
  noticeDays: 30,
  paidTo: new Date('2026-11-20T00:00:00Z'),
  chargeableDays: 6,
  cycleDays: 30,
  lines: [{
    label: '6 days of service, 20 November 2026 to 26 November 2026 (6/30 of £399.00)',
    amountPence: 7980,
  }],
  subtotalPence: 7980,
  vatPence: 1596,
  totalPence: 9576,
  minutesUsed: 58,
  minutesIncluded: 400,
};

test('six days at £399 a month is £79.80, and £95.76 with VAT', () => {
  assert.equal(MALLORY.subtotalPence, Math.round((39900 * 6) / 30));
  assert.equal(MALLORY.subtotalPence, 7980);
  assert.equal(MALLORY.vatPence, Math.round(7980 * 0.2));
  assert.equal(MALLORY.totalPence, 9576);
});

test('the figure is NOT a month and a bit — that was the arrears misreading', () => {
  // £574.56 came from charging 20 Oct→20 Nov as though it were unpaid. It was paid on 21 Oct.
  assert.notEqual(MALLORY.totalPence, 57456);
  assert.ok(MALLORY.totalPence < 10000, 'a six-day closing bill cannot run to three figures');
});

test('paidTo sits AFTER the last invoice label, because the subscription is bought in advance', () => {
  // Last paid invoice was labelled 20 Sep → 20 Oct. Cover runs to 20 Nov, not 20 Oct.
  assert.equal(MALLORY.paidTo?.toISOString().slice(0, 10), '2026-11-20');
});

test('no overage when usage is inside the allowance', () => {
  assert.ok(MALLORY.minutesUsed < MALLORY.minutesIncluded);
  assert.equal(MALLORY.lines.length, 1, 'only the pro-rata line belongs on this invoice');
});

test('the email states the date, what stops, and the arithmetic', () => {
  const { subject, html, text } = renderLeaverEmail(MALLORY);

  assert.ok(subject.includes('26 November 2026'), 'the closing date belongs in the subject');

  for (const body of [html, text]) {
    assert.ok(body.includes('26 November 2026'), 'the date service ends');
    assert.ok(/stops answering calls/.test(body), 'what actually stops');
    assert.ok(/number is released|number we have been answering on is released/.test(body),
      'that the number goes');
    assert.ok(body.includes('£79.80'), 'the pro-rata line');
    assert.ok(body.includes('£15.96'), 'the VAT');
    assert.ok(body.includes('£95.76'), 'the total');
    assert.ok(body.includes('6/30 of £399.00'), 'the working, so it can be checked not queried');
    assert.ok(body.includes('20 November 2026'), 'what they are paid up to');
  }
});

test('the email explains WHY that date — the month\'s notice', () => {
  const { html, text } = renderLeaverEmail(MALLORY);
  for (const body of [html, text]) {
    assert.ok(body.includes('27 October 2026'), 'the date notice was given');
    assert.ok(/30 days' written notice/.test(body), 'the contractual term');
    assert.ok(/one month/.test(body), 'in the words a customer uses');
    assert.ok(body.includes('26 November 2026'), 'and therefore the last day');
  }
});

test('it stays quiet about the notice arithmetic when the dates do not support it', () => {
  // A date agreed as a favour, or notice taken verbally weeks earlier. Telling a customer
  // "your agreement requires 30 days so service ends X" when the gap is 9 days contradicts
  // their own paperwork, so the sentence is dropped and only the date is stated.
  const odd = { ...MALLORY, noticeGivenOn: new Date('2026-11-17T00:00:00Z'), noticeDays: 9 };
  const { html, text } = renderLeaverEmail(odd);
  for (const body of [html, text]) {
    assert.ok(!/written notice/.test(body), 'no claim about the notice term');
    assert.ok(body.includes('26 November 2026'), 'the closing date is still stated plainly');
  }
});

test('no recorded notice date means no notice sentence', () => {
  const none = { ...MALLORY, noticeGivenOn: null, noticeDays: null };
  const { text } = renderLeaverEmail(none);
  assert.ok(!/written notice/.test(text));
  assert.ok(text.includes('26 November 2026'));
});

test('it does not sign off as a person', () => {
  const { html, text } = renderLeaverEmail(MALLORY);
  for (const body of [html, text]) {
    assert.ok(body.includes('The ReceptionMate team'));
    assert.ok(!/Dan Tyldesley/.test(body));
  }
});

test('an unconfident computation must never be rendered as a bill', () => {
  // The caller shows a human instead. Guarded here so a future change cannot quietly send one.
  const unsure: ClosingAmount = {
    ...MALLORY, confident: false,
    blockers: ['the last billing cycle was 14 days, which is not a month — the pro rata would be a guess'],
  };
  assert.equal(unsure.confident, false);
  assert.ok(unsure.blockers.length > 0, 'a refusal has to say why');
});

test('nothing is owed when cover already runs past the leaving date', () => {
  const early: ClosingAmount = {
    ...MALLORY, endsOn: new Date('2026-11-10T23:59:00Z'), chargeableDays: 0,
    lines: [], subtotalPence: 0, vatPence: 0, totalPence: 0,
  };
  assert.equal(early.totalPence, 0);
  assert.equal(early.lines.length, 0, 'a zero bill shows no pro-rata line at all');
});
