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
