import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dispatchAgentName } from './unifiedSip.js';

// The trunk and the dispatch rule are the same in both cases — one LiveKit project, one
// inbound trunk per garage. The only thing that decides WHICH worker joins the room is the
// agent name on the dispatch rule, so that is the one thing that has to follow agentScript.

test('a supervisor garage dispatches to the supervisor worker', () => {
  assert.equal(dispatchAgentName('supervisor-agent'), 'supervisor-agent');
});

test('everything else keeps dispatching to the unified worker', () => {
  assert.equal(dispatchAgentName('unified-agent'), 'unified-agent');
  assert.equal(dispatchAgentName(null), 'unified-agent');
  assert.equal(dispatchAgentName(undefined), 'unified-agent');
  assert.equal(dispatchAgentName('GarageHive-agent'), 'unified-agent');
});

test('whitespace does not send a garage to the wrong worker', () => {
  assert.equal(dispatchAgentName(' supervisor-agent '), 'supervisor-agent');
});
