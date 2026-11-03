import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildConfigurationResponse } from './config.js';
import { upsertAgentConfigurationSchema } from '../utils/validators.js';
import { diaryCapabilities } from '../utils/diaryCapabilities.js';

const minimal = { branchName: 'Test Branch', tonePreference: 'standard', allowFastFitOnly: false };

const row = (over: Record<string, unknown> = {}) =>
  ({
    branchName: 'Test Branch',
    tonePreference: 'standard',
    allowFastFitOnly: false,
    weeklyOpeningHours: null,
    notificationEmails: [],
    integrationProvider: 'none',
    integrationProviderConfig: null,
    ...over,
  }) as never;

test('a garage can be pointed at the supervisor agent', () => {
  const parsed = upsertAgentConfigurationSchema.safeParse({ ...minimal, agentScript: 'supervisor-agent' });
  assert.equal(parsed.success, true);
  assert.equal(parsed.data?.agentScript, 'supervisor-agent');
});

test('the supervisor choice survives the round trip', () => {
  // The script mapper is a long ternary chain that ends in 'receptionmate-agent'. A script it
  // has never heard of silently becomes the oldest agent in the fleet, which is how a garage
  // gets quietly moved off the agent it was put on.
  const res = buildConfigurationResponse(row({ agentScript: 'supervisor-agent' })) as {
    agentScript: string;
  };
  assert.equal(res.agentScript, 'supervisor-agent');
});

test('the supervisor has the same diary capabilities as the agent it replaces', () => {
  // Caller recognition and advisory upsells are per-ADAPTER, not per-script: the supervisor
  // vendored the same adapters, so a Garage Hive garage must keep both when it moves over.
  for (const provider of ['garage_hive', 'bookar', 'poole', 'tyresoft', 'none']) {
    assert.deepEqual(
      diaryCapabilities('supervisor-agent', provider),
      diaryCapabilities('unified-agent', provider),
      `capabilities diverged for ${provider}`,
    );
  }
});

test('an unknown script still gets nothing, so a typo cannot invent capabilities', () => {
  assert.deepEqual(diaryCapabilities('supervisor-agent-x', 'garage_hive'), {
    callerRecognition: false,
    advisoryUpsells: false,
  });
});
