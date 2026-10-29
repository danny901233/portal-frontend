import { test } from 'node:test';
import assert from 'node:assert/strict';

import { upsertAgentConfigurationSchema } from './validators.js';

// The schema's three genuinely required fields. Supplied so each test below fails for the ONE
// reason it is about — the first version of this file parsed {} and all three tests failed on a
// missing branchName, which looked exactly like the bug they were written to catch.
const BASE = { branchName: 'IC Garage LTD', tonePreference: 'standard', allowFastFitOnly: false } as const;

// ── The country a garage's voice agent works in ─────────────────────────────
//
// IC Garage LTD (Naas, Co. Kildare) is the first Republic of Ireland garage on the estate. The
// agent reads `country` to decide which registration and postcode formats to accept, which
// currency to quote, and whether the test it must never offer is an MOT or an NCT.
//
// This is the failure these tests exist to prevent, and it has happened repeatedly in this
// file's own history: zod strips what it does not declare, so an undeclared field is dropped
// from the request body before any handler sees it. Nothing errors, nothing logs, the save
// returns 200, and the setting silently does not exist. `agentName` and `transferNumber` are
// both commented in validators.ts as having been lost exactly this way, `screenBeforeAgent`
// carries a warning about it, and `requiresBookingActivation` cost a show garage £399.
//
// For country the symptom would be especially quiet: the Irish garage keeps behaving as
// British, so its callers' plates never settle and nobody is told why.

test('a country of IE survives validation', () => {
  const parsed = upsertAgentConfigurationSchema.parse({ ...BASE, country: 'IE' });
  assert.equal(parsed.country, 'IE', 'zod stripped country — the field will never save');
});

test('a country of GB survives validation', () => {
  assert.equal(upsertAgentConfigurationSchema.parse({ ...BASE, country: 'GB' }).country, 'GB');
});

test('a garage that sends no country is left alone', () => {
  // Undefined rather than a default here on purpose: the save handler decides, and it reads
  // anything that is not IE as GB. A default in two places is a disagreement waiting to happen.
  assert.equal(upsertAgentConfigurationSchema.parse({ ...BASE }).country, undefined);
});

test('a country we do not support is rejected rather than quietly stored', () => {
  // An enum, not a free string. "IRL", "ie" or a typo must not reach the agent, which compares
  // against exactly "IE" — anything else there reads as Britain, which is the silent failure.
  for (const bad of ['IRL', 'ie', 'FR', 'Ireland', '']) {
    assert.throws(
      () => upsertAgentConfigurationSchema.parse({ ...BASE, country: bad }),
      `country ${JSON.stringify(bad)} should not validate`,
    );
  }
});
