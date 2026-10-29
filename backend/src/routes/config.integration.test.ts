import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseIntegrationSettings, resolveShortCallCallback, resolveCountry } from './config.js';
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


test('an absent field never changes the flag, even from staff', () => {
  // "Not provided" is not "off". Any writer that PUTs a partial config as staff — an admin
  // script, quick-onboard, or a frontend deployed before the toggle existed — would otherwise
  // switch the flag off behind us. The same silent-revert family as the validator strip.
  assert.equal(resolveShortCallCallback(undefined, true, true), true);
  assert.equal(resolveShortCallCallback(undefined, false, true), false);
});


// ── country is admin-only, and must not revert when it is left out ──────────
//
// Flagged by security review on the push that added the field. It was written as an
// unconditional `data.country === 'IE' ? 'IE' : 'GB'`, which is wrong twice over:
//
//   1. A garage user could set it. Admin-only was the requirement, because picking the wrong
//      value breaks plate capture, postcode capture and the currency at once.
//   2. Worse — ANY save that omitted the field reset it to 'GB'. The garage's own settings tab
//      does not send country, so the first time IC Garage saved their opening hours they would
//      have silently become British again: Irish plates stop settling, prices go back to
//      pounds, and nothing anywhere says why.
//
// That second one is the same silent-revert family as resolveShortCallCallback above it, and
// as the validator strip that wiped a garage's FAQs. Same rule, same shape.

test('staff can set the country', () => {
  assert.equal(resolveCountry('IE', 'GB', true), 'IE');
  assert.equal(resolveCountry('GB', 'IE', true), 'GB');
});

test('a garage user cannot change the country', () => {
  assert.equal(resolveCountry('IE', 'GB', false), 'GB');
  assert.equal(resolveCountry('GB', 'IE', false), 'IE');
});

test('a save that omits the country keeps what is already there', () => {
  // The case that would have reverted IC Garage: their settings tab never sends this field.
  assert.equal(resolveCountry(undefined, 'IE', true), 'IE');
  assert.equal(resolveCountry(undefined, 'IE', false), 'IE');
  assert.equal(resolveCountry(undefined, 'GB', true), 'GB');
});

test('an unrecognised country is ignored rather than stored', () => {
  for (const bad of ['IRL', 'ie', 'FR', '']) {
    assert.equal(resolveCountry(bad, 'IE', true), 'IE', `${bad} should not overwrite`);
  }
});

test('a garage with no country yet is British', () => {
  assert.equal(resolveCountry(undefined, undefined, true), 'GB');
  assert.equal(resolveCountry(undefined, null as unknown as undefined, false), 'GB');
});
