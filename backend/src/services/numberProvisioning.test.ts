import { test } from 'node:test';
import assert from 'node:assert/strict';

import { agentNameFor } from './numberProvisioning.js';

// A garage's number is pointed at a named agent worker. This mapping has to agree with the one
// /admin/onboard uses, or a garage provisioned at go-live resolves to a different worker than the
// same garage onboarded by staff — and the call is answered by the wrong script, which looks like
// the agent "forgetting" its configuration rather than like a routing bug.

test('every script the onboarding schema allows maps to itself', () => {
  // These are the values completeOnboardingSchema accepts for agentScript.
  for (const script of [
    'Assist-agent',
    'GarageHive-agent',
    'tyresoft-agent',
    'unified-agent',
    'receptionmate-agent-v3',
  ]) {
    assert.equal(agentNameFor(script), script);
  }
});

test('the show funnel’s script maps to the unified worker', () => {
  // Every Blend garage runs unified-agent; getting this wrong is what makes a number ring out.
  assert.equal(agentNameFor('unified-agent'), 'unified-agent');
});

test('an unknown or missing script falls back to the default worker', () => {
  assert.equal(agentNameFor(null), 'receptionmate-agent');
  assert.equal(agentNameFor(undefined), 'receptionmate-agent');
  assert.equal(agentNameFor(''), 'receptionmate-agent');
  assert.equal(agentNameFor('something-we-removed'), 'receptionmate-agent');
});

test('the fallback is never silently the unified agent', () => {
  // The unified agent needs its own SIP trunk in a separate LiveKit project. Defaulting an
  // unknown script to it would wire a trunk for a garage that is not on it.
  assert.notEqual(agentNameFor('mystery'), 'unified-agent');
});

// ── Concurrency ────────────────────────────────────────────────────────────
//
// announceGoLiveIfReady is called from BOTH onboarding tracks on purpose — whichever finishes
// last triggers go-live — so an agreement signed at the same moment the diary connects enters
// here twice. Without a guard both calls pass the "has a number?" check and buy one, and the
// second is a number we pay for that nothing points at.

import { provisionNumberForGarage } from './numberProvisioning.js';

test('concurrent calls for one garage share a single attempt', async () => {
  // No DB here: a garage id that cannot resolve still proves the de-duplication, because both
  // callers must come back with the very same promise result rather than running twice.
  const a = provisionNumberForGarage('concurrency-probe');
  const b = provisionNumberForGarage('concurrency-probe');
  assert.equal(a, b, 'the second caller should receive the first call’s promise');
  await Promise.allSettled([a, b]);
});

test('the lock is released so a later retry can run', async () => {
  const first = provisionNumberForGarage('retry-probe');
  await Promise.allSettled([first]);
  const second = provisionNumberForGarage('retry-probe');
  assert.notEqual(first, second, 'a call after the first settled should be a fresh attempt');
  await Promise.allSettled([second]);
});
