import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SHOW_TERMS,
  SUPPORTED_GMS,
  showGarageBilling,
  showAgreementTerms,
} from './show-signup.js';

// ── The offer: free until the AI books 4 customers ─────────────────────────
//
// This is the part that fails quietly. `requiresBookingActivation` defaults to FALSE in the
// schema, and /admin/onboard never persisted it — completeOnboardingSchema does not declare
// the field, so zod strips what the Quick Onboard modal posts. A garage created without it
// looks completely normal: the agreement still renders "free until 4 bookings", the portal
// still shows the deal, and then confirm-mandate charges them £399 the day they set up their
// Direct Debit. Nothing errors. These tests exist so that cannot happen silently again.

test('a show garage is NOT billable until the agreed number of bookings', () => {
  const g = showGarageBilling();
  assert.equal(g.requiresBookingActivation, true);
  assert.equal(g.bookingsRequiredForActivation, 4);
  assert.equal(g.activationBookingsCount, 0);
  assert.equal(g.subscriptionActivatedAt, null);
});

test('the garage starts in the pipeline, not live', () => {
  // Left at the schema default of 'live', setOnboardingStage refuses to move it ("already
  // onboarded — not ours to touch"), so signing could never advance it to awaiting_credentials
  // and nobody would ever be asked for the GMS credentials.
  assert.equal(showGarageBilling().onboardingStage, 'awaiting_agreement');
});

test('the show is priced at the standard Automate rate, not a discount', () => {
  // The offer is the free period. Undercutting £399 would put a Blend signup below the six
  // garages already paying it.
  const g = showGarageBilling();
  assert.equal(g.subscriptionCostGbp, 399);
  assert.equal(g.includedMinutes, 600);
  assert.equal(g.costPerMinuteGbp, 0.25);
  assert.equal(g.vatRate, 0.2);
});

test('voice is on and Connect is off', () => {
  const g = showGarageBilling();
  assert.equal(g.hasVoiceAccess, true);
  assert.equal(g.hasMessagingAccess, false);
});

// ── The agreement has to say the same thing the billing does ───────────────

test('the agreement promises the booking-based free period and no day-based trial', () => {
  const a = showAgreementTerms();
  assert.equal(a.freeUntilBookings, 4);
  // agreementTemplate renders the day-count clause in preference to the booking one, so a
  // non-null freeTrialDays here would put "14-day free trial" on a contract sold on bookings.
  assert.equal(a.freeTrialDays, null);
});

test('the agreement and the garage agree on the booking count', () => {
  // Two numbers, one promise: the contract clause and the flag that actually gates billing.
  assert.equal(showAgreementTerms().freeUntilBookings, showGarageBilling().bookingsRequiredForActivation);
});

test('the agreement and the garage agree on the monthly fee', () => {
  assert.equal(showAgreementTerms().licenceFeeGbp, showGarageBilling().subscriptionCostGbp);
});

test('the agreement is for Automate only', () => {
  const a = showAgreementTerms();
  assert.deepEqual([...a.licences], ['automate']);
  assert.equal(a.setupFeeGbp, 0);
  assert.equal(a.centresCount, 1);
  assert.equal(a.messagingFeeGbp, 0);
});

// ── GMS answer -> diary adapter ────────────────────────────────────────────

test('each supported GMS maps to its diary provider', () => {
  assert.equal(SUPPORTED_GMS.garagehive, 'garage_hive');
  assert.equal(SUPPORTED_GMS.bookar, 'bookar');
  assert.equal(SUPPORTED_GMS.tyresoft, 'tyresoft');
  // AutoSage is Poole Software. The provider key is our internal shorthand; the label the
  // garage and the provider both use is AutoSage.
  assert.equal(SUPPORTED_GMS.autosage, 'poole');
});

test('only the four diaries with a booking adapter are offered', () => {
  // CAM has no adapter and must not reach this endpoint — a CAM garage picks "Other" on the
  // funnel and is captured as a lead instead.
  assert.deepEqual(Object.keys(SUPPORTED_GMS).sort(), ['autosage', 'bookar', 'garagehive', 'tyresoft']);
});

test('every provider key is one the diary-connect service can actually email', () => {
  // sendDiaryConnectRequest only knows bookar / poole / tyresoft, and garage_hive is handled by
  // garageHiveConnect instead. A key outside that set would strand the signup at
  // awaiting_credentials with nobody asked for credentials.
  const requestable = new Set(['bookar', 'poole', 'tyresoft', 'garage_hive']);
  for (const provider of Object.values(SUPPORTED_GMS)) {
    assert.ok(requestable.has(provider), `${provider} has no credential-request path`);
  }
});

test('SHOW_TERMS is the single source of the booking count', () => {
  assert.equal(SHOW_TERMS.bookingsRequiredForActivation, 4);
});

// ── The emails ─────────────────────────────────────────────────────────────
//
// Both exist because the sign link used to live in exactly one browser tab. A flat phone or a
// closed tab left a garage with a created account, a drafted agreement and no way back to
// either — and an Agreement row claiming sentAt/sentToEmail for an email nobody sent.

import { buildInterestEmail, buildSignLinkEmail, offerSummaryText } from './show-signup.js';

test('the offer email quotes the same terms the garage is created with', () => {
  const t = offerSummaryText();
  assert.match(t, /£399/);
  assert.match(t, /600 minutes/);
  assert.match(t, /books 4 customers|booking 4/);
});

test('the offer terms in the email cannot drift from the ones that gate billing', () => {
  const t = offerSummaryText();
  assert.ok(t.includes(String(showGarageBilling().subscriptionCostGbp)));
  assert.ok(t.includes(String(showGarageBilling().bookingsRequiredForActivation)));
});

test('the sign-link email carries the link', () => {
  const url = 'https://portal.receptionmate.co.uk/agreement/sign?token=abc123';
  const { html, text } = buildSignLinkEmail('Acme Auto', url);
  assert.ok(html.includes(url));
  assert.ok(text.includes(url));
});

test('the interest email points back at the funnel, not at a sign link', () => {
  const { html, text } = buildInterestEmail('Acme Auto');
  assert.ok(html.includes('/blend'));
  assert.ok(text.includes('/blend'));
  // No account exists for these people, so there must be nothing here that implies one does.
  assert.ok(!/agreement\/sign/.test(html));
});

test('both emails warn that the Direct Debit needs bank details', () => {
  // The single most common reason a signup stalls at a trade show: nobody carries their account
  // number and sort code. Saying so up front turns a dead end into "finish it from the office".
  assert.match(buildInterestEmail('Acme Auto').text, /bank details/i);
  assert.match(buildSignLinkEmail('Acme Auto', 'https://x/y').text, /sort code/i);
});

test('a garage name cannot inject markup into either email', () => {
  const bad = '"><a href="https://evil.example">click</a><!--';
  for (const { html } of [buildInterestEmail(bad), buildSignLinkEmail(bad, 'https://x/y')]) {
    assert.ok(!html.includes('<a href="https://evil.example">'), 'injected anchor survived');
  }
});
