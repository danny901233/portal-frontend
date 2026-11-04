import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { renameForAgent, retargetRule, rulePrefix } from './unifiedSip.js';

// Dan, 4 Nov 2026: "we want it in the portal so we can switch between supervisor or unified".
// The agent name on the garage's dispatch rule is the switch; a save has to move it.

const rule = (agentName: string, name = 'Route to Elite Autocare (unified-agent)') =>
  ({
    sipDispatchRuleId: 'SDR_x',
    name,
    rule: { rule: { case: 'dispatchRuleIndividual', value: { roomPrefix: 'garage-abc' } } },
    roomConfig: { agents: [{ agentName }] },
  }) as never;

test('the rule is found by its room prefix', () => {
  assert.equal(rulePrefix(rule('unified-agent')), 'garage-abc');
  assert.equal(rulePrefix({} as never), '');
});

test('switching to the supervisor moves the agent and the name', () => {
  const r = rule('unified-agent') as { name: string; roomConfig: { agents: { agentName: string }[] } };
  assert.deepEqual(retargetRule(r as never, 'supervisor-agent'), { changed: true, from: 'unified-agent' });
  assert.equal(r.roomConfig.agents[0].agentName, 'supervisor-agent');
  assert.equal(r.name, 'Route to Elite Autocare (supervisor-agent)');
});

test('switching back works the same way', () => {
  const r = rule('supervisor-agent', 'Route to X (supervisor-agent)') as { roomConfig: { agents: { agentName: string }[] } };
  assert.deepEqual(retargetRule(r as never, 'unified-agent'), { changed: true, from: 'supervisor-agent' });
  assert.equal(r.roomConfig.agents[0].agentName, 'unified-agent');
});

test('a rule already on the right agent is left alone', () => {
  assert.deepEqual(retargetRule(rule('supervisor-agent') as never, 'supervisor-agent'), { changed: false, from: 'supervisor-agent' });
});

test('a rule serving some other agent is never touched', () => {
  const r = rule('MMH-agent') as { roomConfig: { agents: { agentName: string }[] } };
  assert.deepEqual(retargetRule(r as never, 'supervisor-agent'), { changed: false, from: 'MMH-agent', refused: true });
  assert.equal(r.roomConfig.agents[0].agentName, 'MMH-agent');
});

test('a name without an agent suffix is kept', () => {
  assert.equal(renameForAgent('Route to Elite Autocare', 'supervisor-agent'), 'Route to Elite Autocare');
});

test('a portal save moves the rule, and the callback dials the garage\'s agent', () => {
  const cfg = readFileSync(new URL('../routes/config.ts', import.meta.url), 'utf8');
  assert.match(cfg, /setUnifiedDispatchAgent\(garageId, resolvedAgentScript\)/);
  const cb = readFileSync(new URL('./callbackDial.ts', import.meta.url), 'utf8');
  assert.match(cb, /dispatchAgentName\(/);
});
