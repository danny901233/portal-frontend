import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseIntegrationSettings } from './config.js';

// Garage Hive credentials live in integrationProviderConfig in two shapes. Most rows are flat
// ({ apiKey, customerId, ... }); some — VWGS Performance among them — are nested under a
// `garagehive` key. The chat agent, the chat router and the non-unified read path all accept
// both. The unified-agent branch only read the flat shape, so a nested row came back with an
// EMPTY credentials block, the setup form rendered blanks, and the next save echoed those blanks
// back: the validator then refused the whole save ("Provide the Garage Hive instance name
// before saving"), so VWGS could not change their agent's name — or anything else.

const NESTED = {
  hubspot: { enabled: false, ownerId: '', apiToken: '' },
  garagehive: {
    apiKey: 'test-api-key',
    customerId: 'vwgroupspecialist',
    locationId: '9',
    instanceUrl: 'vwgroupspecialist',
  },
};

const FLAT = {
  apiKey: 'test-api-key',
  customerId: 'vwgroupspecialist',
  locationId: '9',
  instanceUrl: 'vwgroupspecialist',
};

test('unified agent reads Garage Hive credentials nested under `garagehive`', () => {
  const { integrationProvider, garageHiveSettings } = parseIntegrationSettings(
    'garage_hive',
    NESTED,
    'unified-agent',
  );
  assert.equal(integrationProvider, 'garage_hive');
  assert.equal(garageHiveSettings.instanceUrl, 'vwgroupspecialist');
  assert.equal(garageHiveSettings.apiKey, 'test-api-key');
  assert.equal(garageHiveSettings.customerId, 'vwgroupspecialist');
  assert.equal(garageHiveSettings.locationId, '9');
});

test('unified agent still reads the flat Garage Hive shape', () => {
  const { integrationProvider, garageHiveSettings } = parseIntegrationSettings(
    'garage_hive',
    FLAT,
    'unified-agent',
  );
  assert.equal(integrationProvider, 'garage_hive');
  assert.equal(garageHiveSettings.instanceUrl, 'vwgroupspecialist');
  assert.equal(garageHiveSettings.apiKey, 'test-api-key');
  assert.equal(garageHiveSettings.locationId, '9');
});

// The provider dropdown infers the diary from whichever credentials are present when the stored
// provider is still 'none'. A nested row has to be inferable the same way a flat one is.
test('a nested Garage Hive row is inferred as garage_hive when no provider is declared', () => {
  const { integrationProvider } = parseIntegrationSettings(null, NESTED, 'unified-agent');
  assert.equal(integrationProvider, 'garage_hive');
});

// Nothing nested must leak into the other diaries' credential blocks.
test('a nested Garage Hive row leaves the other diaries empty', () => {
  const { tyresoftSettings, bookarSettings, pooleSettings } = parseIntegrationSettings(
    'garage_hive',
    NESTED,
    'unified-agent',
  );
  assert.equal(tyresoftSettings.tsApiKey, '');
  assert.equal(bookarSettings?.bookarClientId, '');
  assert.equal(pooleSettings?.branchKey, '');
});
