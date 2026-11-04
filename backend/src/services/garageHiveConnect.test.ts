import { test } from 'node:test';
import assert from 'node:assert/strict';

import { diaryIsConnected } from './garageHiveConnect.js';

// Go-live waits for two things: a signed agreement and a connected diary. For an Assist garage
// there is no diary — the agent takes messages and books nothing — so the second condition can
// never be met and the garage never goes live: no number bought, no login email sent. Cawteco
// signed on 22 Oct 2026 and sat at "awaiting credentials" for three weeks that way.

test('an Assist garage with no diary provider counts as connected', () => {
  assert.equal(diaryIsConnected({}, 'none', 'Assist-agent'), true);
});

test('a diary-backed script with no provider is still not connected', () => {
  // The unified agent needs real credentials; "none" there means staff have not picked a provider yet.
  assert.equal(diaryIsConnected({}, 'none', 'unified-agent'), false);
  assert.equal(diaryIsConnected({}, 'none', 'receptionmate-agent-v3'), false);
});

test('Assist with a provider set is judged on that provider, not waved through', () => {
  // A garage pointed at Assist by mistake while its GarageHive credentials are pending must
  // still wait for them.
  assert.equal(diaryIsConnected({}, 'garage_hive', 'Assist-agent'), false);
});

test('a GarageHive garage is connected once both ids are present', () => {
  assert.equal(diaryIsConnected({ customerId: 'c', locationId: '1' }, 'garage_hive', 'unified-agent'), true);
  assert.equal(diaryIsConnected({ customerId: 'c' }, 'garage_hive', 'unified-agent'), false);
});

test('the default script is never connected on its own', () => {
  assert.equal(diaryIsConnected({}, 'none', 'receptionmate-agent'), false);
});
