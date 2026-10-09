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
