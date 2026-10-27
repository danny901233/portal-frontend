import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PROVIDER_KEYS } from '../services/diaryConnect.js';

// Every diary the quick-onboard modal offers. Kept here as a literal rather than imported,
// because the point of these tests is to notice when the two lists stop agreeing — importing the
// same value twice would prove nothing.
const QUICK_ONBOARD_PROVIDERS = ['none', 'garage_hive', 'bookar', 'poole', 'tyresoft', 'demo'];

// Woodyard Garage was quick-onboarded on 27 Oct with provider 'bookar' and nobody at Bookar was
// ever asked for credentials: the request only ever fired on agreement signing, which a quick
// onboard never produces. The onboard route now sends it, and these guard the seam.

test('every diary a quick onboard can pick has a way to ask for credentials', () => {
  // 'none' and 'demo' need no provider. GarageHive deliberately keeps its own path — the admin
  // "Connect GarageHive" button, where we paste an instance and match branches ourselves — so it
  // is excluded here rather than missing.
  const needsRequest = QUICK_ONBOARD_PROVIDERS.filter((p) => !['none', 'demo', 'garage_hive'].includes(p));
  for (const provider of needsRequest) {
    assert.ok(
      (PROVIDER_KEYS as string[]).includes(provider),
      `${provider} can be chosen at onboard but no connect request would ever be sent for it`,
    );
  }
});

test('the providers that handle themselves are not emailed twice', () => {
  for (const provider of ['none', 'demo', 'garage_hive']) {
    assert.ok(
      !(PROVIDER_KEYS as string[]).includes(provider),
      `${provider} would now be emailed by both the onboard route and its own flow`,
    );
  }
});
