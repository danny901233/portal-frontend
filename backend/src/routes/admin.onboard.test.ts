import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PROVIDER_KEYS, DIARY_AGENT_SCRIPT } from '../services/diaryConnect.js';

// Every diary the quick-onboard modal offers. Kept here as a literal rather than imported,
// because the point of these tests is to notice when the two lists stop agreeing — importing the
// same value twice would prove nothing.
const QUICK_ONBOARD_PROVIDERS = ['none', 'garage_hive', 'bookar', 'poole', 'tyresoft', 'demo'];

// Every agent the quick-onboard modal offers, same reasoning as above.
const QUICK_ONBOARD_AGENTS = [
  'Assist-agent',
  'GarageHive-agent',
  'tyresoft-agent',
  'unified-agent',
  'receptionmate-agent-v3',
  'receptionmate-agent',
];

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

// JLK Vehicle Solutions was onboarded the same day as Assist-agent WITH provider 'bookar'. Assist
// has no diary, and diary-connect's submit handler sets a garage's agentScript to unified-agent —
// so emailing a provider about an Assist garage risks converting it when they fill the form in.
test('only the unified agent can have a diary connected', () => {
  assert.equal(DIARY_AGENT_SCRIPT, 'unified-agent');
  assert.ok(QUICK_ONBOARD_AGENTS.includes(DIARY_AGENT_SCRIPT));
});

test('no other onboardable agent is treated as diary-capable', () => {
  const diaryCapable = QUICK_ONBOARD_AGENTS.filter((a) => a === DIARY_AGENT_SCRIPT);
  assert.deepEqual(diaryCapable, ['unified-agent']);
});
