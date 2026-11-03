import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { buildConfigurationResponse } from './config.js';
import { upsertAgentConfigurationSchema } from '../utils/validators.js';
import { SERVICE_CATALOGUE, SERVICE_KEYS } from '../utils/servicesCatalogue.js';

/** The least a save can carry and still be valid. */
const minimal = { branchName: 'Test Branch', tonePreference: 'standard', allowFastFitOnly: false };

// A Prisma AgentConfiguration row, only as far as buildConfigurationResponse reads it.
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

test('the catalogue is a controlled vocabulary with unique keys and spoken labels', () => {
  assert.ok(SERVICE_CATALOGUE.length >= 25);
  assert.equal(new Set(SERVICE_KEYS).size, SERVICE_KEYS.length);
  for (const entry of SERVICE_CATALOGUE) {
    assert.match(entry.key, /^[a-z][a-z0-9_]*$/);
    assert.ok(entry.label.length > 1);
    assert.ok(entry.group.length > 1);
  }
});

test('a save carries the services the garage ticked and the ones it typed in', () => {
  const parsed = upsertAgentConfigurationSchema.safeParse({
    ...minimal,
    servicesOffered: ['mot', 'tyres', 'timing_belt'],
    servicesCustom: ['Remapping', 'LPG conversions'],
  });
  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.data?.servicesOffered, ['mot', 'tyres', 'timing_belt']);
  assert.deepEqual(parsed.data?.servicesCustom, ['Remapping', 'LPG conversions']);
});

test('a service key outside the catalogue is refused, not quietly dropped', () => {
  const parsed = upsertAgentConfigurationSchema.safeParse({
    ...minimal,
    servicesOffered: ['mot', 'spaceship_mot'],
  });
  assert.equal(parsed.success, false);
});

test('a garage that ticks nothing is not the same as a garage that has not answered', () => {
  // [] means "we do none of these" and the agent may say no.
  const none = upsertAgentConfigurationSchema.safeParse({ ...minimal, servicesOffered: [] });
  assert.equal(none.success, true);
  assert.deepEqual(none.data?.servicesOffered, []);

  // Absent means unconfigured: the agent must claim nothing either way.
  const silent = upsertAgentConfigurationSchema.safeParse({ ...minimal });
  assert.equal(silent.success, true);
  assert.equal(silent.data?.servicesOffered, undefined);
});

test('the unconfigured state survives the round trip as null, never as an empty list', () => {
  const res = buildConfigurationResponse(row({ servicesOffered: null, servicesCustom: [] })) as {
    servicesOffered: unknown;
    servicesCustom: unknown;
  };
  assert.equal(res.servicesOffered, null);
  assert.deepEqual(res.servicesCustom, []);
});

test('what a garage ticked comes back on the next load', () => {
  const res = buildConfigurationResponse(
    row({ servicesOffered: ['mot', 'brakes'], servicesCustom: ['Remapping'] }),
  ) as { servicesOffered: unknown; servicesCustom: unknown };
  assert.deepEqual(res.servicesOffered, ['mot', 'brakes']);
  assert.deepEqual(res.servicesCustom, ['Remapping']);
});

test('the catalogue itself stays out of the config the agent reads', () => {
  // The whole configuration object is serialised into DynamoDB for the voice agent. The
  // vocabulary is reference data the agent already has; only the garage's ANSWER belongs here.
  const res = buildConfigurationResponse(row()) as Record<string, unknown>;
  assert.equal('servicesCatalogue' in res, false);
  assert.equal('servicesOffered' in res, true);
});

test('the portal UI catalogue and the validator catalogue are the same vocabulary', () => {
  // The tab renders from its own copy (the frontend cannot import backend/src). If the two
  // lists drift, a garage can tick a pill the validator then refuses.
  const ui = readFileSync(resolve(import.meta.dirname, '../../../app/lib/servicesCatalogue.ts'), 'utf8');
  const uiKeys = [...ui.matchAll(/key:\s*'([a-z0-9_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(uiKeys, [...SERVICE_KEYS]);
});
