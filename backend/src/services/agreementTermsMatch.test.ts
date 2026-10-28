/**
 * The contract the customer SIGNS and the contract they are SENT must say the same thing.
 *
 * There are two renderings of one agreement: agreementTemplate.ts produces the HTML they read and
 * sign on screen, captured into Agreement.templateSnapshot; agreementPdf.ts produces the PDF
 * emailed as their signed copy, which is the only version they keep. Each carried its own copy of
 * the clauses, and nothing connected them.
 *
 * On 9 July 2026 the HTML moved to a three-month Proof Period plus a twelve-month Contract Term
 * with no termination for convenience. The PDF was left saying "rolling monthly term" with thirty
 * days' notice and had no free-period clauses at all. Thirteen garages signed one contract and
 * were emailed a materially different one. It surfaced on 28 Oct 2026 only because Mallory
 * Performance gave notice and their exit was priced from the database, which disagreed with the
 * PDF in their hand.
 *
 * Both renderers now take their wording from agreementTerms.ts, so divergence is no longer
 * possible by construction. These tests guard the two things construction cannot: that the HTML
 * really does emit the shared text, and that the superseded wording has not come back.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { renderAgreementHtml, type LicenceTier } from './agreementTemplate.js';
import {
  clause31, clause32, clause33, clause131, clause132, clause133, freePeriodShape,
} from './agreementTerms.js';

const BASE = {
  clientName: 'Test Garage Ltd',
  setupFeeGbp: 0,
  licenceFeeGbp: 399,
  centresCount: 1,
  messagingFeeGbp: 0,
  messagingCentresCount: null,
  licences: ['automate'] as LicenceTier[],
  goLiveDate: null,
  effectiveDate: new Date('2026-10-28'),
  signedByName: 'A Signer',
  signedByPosition: 'Director',
  signatureImage: null,
};

/** HTML → plain text, so markup and entities cannot hide a phrase. */
const asText = (html: string): string =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&ldquo;|&rdquo;|&quot;/g, '"')
    .replace(/&rsquo;|&lsquo;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const CASES: Array<[string, { freeTrialDays: number | null; freeUntilBookings: number | null }]> = [
  ['no free period', { freeTrialDays: null, freeUntilBookings: null }],
  ['a 14-day free trial', { freeTrialDays: 14, freeUntilBookings: null }],
  ['free until 20 bookings', { freeTrialDays: null, freeUntilBookings: 20 }],
];

for (const [label, period] of CASES) {
  test(`the signed HTML carries the shared term and termination clauses — ${label}`, () => {
    const free = freePeriodShape(period);
    const text = asText(renderAgreementHtml({ ...BASE, ...period }));

    for (const [name, clause] of [
      ['3.1', clause31(free)],
      ['3.2', clause32(free)],
      ['3.3', clause33()],
      ['13.1', clause131(free)],
      ['13.2', clause132()],
      ['13.3', clause133()],
    ] as const) {
      assert.ok(
        text.includes(asText(clause)),
        `clause ${name} is not in the rendered agreement — the HTML and the emailed PDF have `
        + 'drifted apart again',
      );
    }
  });
}

test('the superseded rolling-monthly wording is gone from the shared clauses', () => {
  const free = freePeriodShape({ freeTrialDays: null, freeUntilBookings: null });
  const all = [clause31(free), clause32(free), clause33(),
    clause131(free), clause132(), clause133()].join(' ');

  for (const dead of ['rolling monthly term', 'monthly rolling basis', 'Initial Period of 3 months']) {
    assert.ok(!all.includes(dead), `"${dead}" was removed on 9 July 2026 and must not return`);
  }
  // And the commitment the agreement actually carries.
  for (const live of ['Proof Period', 'Contract Term', 'twelve (12) months',
    'may not terminate for convenience', 'remaining Licence Fees']) {
    assert.ok(all.includes(live), `the agreement must still state "${live}"`);
  }
});

test('a free period that was sold is stated in the clauses, not only in the fees section', () => {
  const trial = freePeriodShape({ freeTrialDays: 14, freeUntilBookings: null });
  assert.ok(clause31(trial).includes('14-day free trial'));
  assert.ok(clause131(trial).includes('cancel at any time during the free trial'));

  const bookings = freePeriodShape({ freeTrialDays: null, freeUntilBookings: 20 });
  assert.ok(clause31(bookings).includes('20 confirmed bookings'));
  assert.ok(clause131(bookings).includes('cancel at any time during the free period'));
});
