/**
 * A Garage Hive garage can be saved without an "Instance URL".
 *
 * IC Garage LTD, 30 Oct 2026: a live customer could not save their agent config at all.
 *
 *   PUT /api/garages/633905c2…/agent-config -> 400
 *   { "garageHiveSettings": ["Provide the Garage Hive instance name before saving."] }
 *
 * The form asks for an "Instance URL" and its placeholder shows a full URL. The validator
 * rejected anything containing "://" AND rejected an empty value, and the error used a phrase
 * — "instance name" — that appears nowhere on the form. Follow the placeholder and you are
 * refused; leave it blank and you are refused.
 *
 * The field is read by NOTHING. It is declared in types.ts, validated here, and consumed by no
 * caller: the diary adapter works from apiKey + customerId against a fixed base, and the only
 * mention in the whole agent is a comment. VICPros hit this the day before, and Cartopia,
 * Testwood Lakes and VWGS Performance are all stored without one.
 *
 * The format rules are kept — a value that IS supplied should still be the instance name
 * rather than a URL — but it is no longer a reason to refuse a save.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { upsertAgentConfigurationSchema } from './validators.js';

// The schema covers the whole agent config, so these three unrelated required fields are
// supplied to isolate what is under test: the Garage Hive instance rule.
const base = {
  branchName: 'IC Garage LTD',
  tonePreference: 'standard',
  allowFastFitOnly: false,
  integrationProvider: 'garage_hive',
  garageHiveSettings: { apiKey: 'k'.repeat(32), customerId: 'ictyrecentre', locationId: '169' },
};

test('IC Garage: a Garage Hive config with no instance URL now saves', () => {
  const r = upsertAgentConfigurationSchema.safeParse(base);
  assert.equal(r.success, true, JSON.stringify((r as any).error?.flatten?.()));
});

test('an empty string is accepted too — the form sends one', () => {
  const r = upsertAgentConfigurationSchema.safeParse({
    ...base, garageHiveSettings: { ...base.garageHiveSettings, instanceUrl: '' },
  });
  assert.equal(r.success, true);
});

test('a normal instance name still passes', () => {
  const r = upsertAgentConfigurationSchema.safeParse({
    ...base, garageHiveSettings: { ...base.garageHiveSettings, instanceUrl: 'hpmotors' },
  });
  assert.equal(r.success, true);
});

test('a full URL is still refused, with the message that says why', () => {
  const r = upsertAgentConfigurationSchema.safeParse({
    ...base,
    garageHiveSettings: { ...base.garageHiveSettings, instanceUrl: 'https://x.garagehive.co.uk' },
  });
  assert.equal(r.success, false);
  const msgs = JSON.stringify((r as any).error.flatten());
  assert.ok(/only the instance name/i.test(msgs), msgs);
});

test('junk in the instance name is still refused', () => {
  const r = upsertAgentConfigurationSchema.safeParse({
    ...base, garageHiveSettings: { ...base.garageHiveSettings, instanceUrl: 'has spaces!' },
  });
  assert.equal(r.success, false);
});
