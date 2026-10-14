import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseIntegrationSettings, resolveShortCallCallback } from './config.js';
import { upsertAgentConfigurationSchema } from '../utils/validators.js';

/** The least a save can carry and still be valid. */
const minimalConfig = { branchName: 'Test Branch', tonePreference: 'standard', allowFastFitOnly: false };

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

// ── The agent-config flag that must survive a save ──────────────────────────────────────────
//
// A field missing from upsertAgentConfigurationSchema is dropped on every save with no error:
// the path that quietly reverted ten settings and wiped a garage's FAQs to []. This is the
// tripwire for shortCallCallback, which decides whether we place outbound calls at all.

test('shortCallCallback survives the validator', () => {
  const parsed = upsertAgentConfigurationSchema.parse({ ...minimalConfig, shortCallCallback: true });
  assert.equal(parsed.shortCallCallback, true);
});

test('shortCallCallback set to false survives, rather than vanishing', () => {
  const parsed = upsertAgentConfigurationSchema.parse({ ...minimalConfig, shortCallCallback: false });
  assert.equal(parsed.shortCallCallback, false);
});

// ── shortCallCallback is staff-only, and that has to hold server-side ───────────────────────
//
// Flagged by the commit security review as broken access control. The UI hides the toggle
// behind isReceptionMateStaff, but that is a client-side gate: a garage user could POST the
// field straight to this endpoint and start placing outbound calls in their own name, on our
// LiveKit and Twilio minutes, before anyone had watched the feature work. Same shape as the
// agentScript rule a few lines above it in config.ts.

test('staff can turn the callback flag on and off', () => {
  assert.equal(resolveShortCallCallback(true, false, true), true);
  assert.equal(resolveShortCallCallback(false, true, true), false);
});

test('a garage user cannot switch it on by posting the field', () => {
  assert.equal(resolveShortCallCallback(true, false, false), false);
});

test('a garage user saving other settings does not switch it off either', () => {
  // The ordinary case: the toggle is not in their form, so the field arrives undefined and the
  // saved value has to survive the save.
  assert.equal(resolveShortCallCallback(undefined, true, false), true);
  assert.equal(resolveShortCallCallback(false, true, false), true);
});

test('an absent field from staff means off, since the form always sends it', () => {
  assert.equal(resolveShortCallCallback(undefined, true, true), false);
});
