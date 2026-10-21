/**
 * The analyst pass returns a LIST of faults, which is the whole point: the
 * existing per-call verdict has room for ONE category, so on call 16056346 it
 * reported how the agent asked for a name and the plate it had never been told
 * had nowhere to go. A classifier cannot report two independent faults.
 *
 * These tests cover the parts that must not depend on a model's goodwill: the
 * vocabulary, the severity clamp, and the rules Dan has corrected me on, which
 * belong in code rather than in a prompt the model may ignore.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeFindings, FAULT_CATEGORIES } from './callFaults.js';

const ctx = { capabilities: { bookings: true, retrieve_booking: false }, hasDiary: true };

test('a finding survives with its category, severity and evidence', () => {
  const out = normalizeFindings(
    [{ category: 'dead_air', severity: 'high', headline: 'Caller waited 13s', detail: 'A 13 second gap mid-call.', evidence: 'are you still there?' }],
    ctx,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].category, 'dead_air');
  assert.equal(out[0].severity, 'high');
  assert.match(out[0].detail, /13 second/);
  assert.equal(out[0].evidence, 'are you still there?');
});

test('an off-vocabulary category becomes other rather than being dropped', () => {
  const out = normalizeFindings([{ category: 'vibes_were_off', severity: 'low', headline: 'h', detail: 'd' }], ctx);
  assert.equal(out.length, 1);
  assert.equal(out[0].category, 'other');
});

test('an unknown severity becomes medium', () => {
  const out = normalizeFindings([{ category: 'other', severity: 'catastrophic', headline: 'h', detail: 'd' }], ctx);
  assert.equal(out[0].severity, 'medium');
});

test('a finding with no detail is dropped — it is not reportable', () => {
  assert.equal(normalizeFindings([{ category: 'other', severity: 'low', headline: 'h', detail: '  ' }], ctx).length, 0);
});

test('nothing wrong means an empty list, not a reassuring finding', () => {
  assert.equal(normalizeFindings([], ctx).length, 0);
  assert.equal(normalizeFindings(null, ctx).length, 0);
  assert.equal(normalizeFindings('not an array', ctx).length, 0);
});

// ── the rules Dan has had to tell me more than once ───────────────────────

test('a booking fault at a garage with NO diary is dropped', () => {
  // "An agent with no diary isnt a failure." Taking a message IS the success.
  const out = normalizeFindings(
    [{ category: 'booking_failure', severity: 'high', headline: 'No booking made', detail: 'The agent took a message instead of booking.' }],
    { capabilities: {}, hasDiary: false },
  );
  assert.equal(out.length, 0);
});

test('an unresolved fault the agent had no tool for is dropped', () => {
  // call 89027777 — checking an existing appointment with retrieve_booking off.
  const out = normalizeFindings(
    [{ category: 'unresolved', severity: 'high', headline: 'Could not check the booking',
       detail: 'The caller asked about their existing booking and the agent could not look it up.',
       callerIntent: 'check appointment status' }],
    ctx,
  );
  assert.equal(out.length, 0);
});

test('an earlier drop-off is dropped however the model dresses it up', () => {
  // call 35204772, the one Dan corrected. No integration knows workshop capacity.
  const out = normalizeFindings(
    [{ category: 'unresolved', severity: 'medium', headline: 'Drop-off not confirmed',
       detail: 'The caller asked to drop the car off earlier and got no answer.',
       callerIntent: 'drop off car earlier' }],
    { capabilities: { bookings: true, retrieve_booking: true, cancel: true }, hasDiary: true },
  );
  assert.equal(out.length, 0);
});

test('the same unresolved fault IS kept when the agent had the tool', () => {
  const out = normalizeFindings(
    [{ category: 'unresolved', severity: 'high', headline: 'Could not check the booking',
       detail: 'The caller asked about their existing booking and the agent never looked it up.',
       callerIntent: 'check appointment status' }],
    { capabilities: { bookings: true, retrieve_booking: true }, hasDiary: true },
  );
  assert.equal(out.length, 1);
});

test('an incomplete message is capped at medium, because the garage is emailed anyway', () => {
  // Dan, repeatedly: every call over 30s is sent to the portal and emailed, so a
  // message that did not save is a data-quality fault, not a lost lead.
  const out = normalizeFindings(
    [{ category: 'tool_failure', severity: 'high', headline: 'Message never saved',
       detail: 'take_message stopped at NEED_NAME and recorded nothing.' }],
    ctx,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].severity, 'medium');
});

test('a read-back pause is never a dead-air fault', () => {
  // The ~5s mute during a registration read-back is deliberate.
  const out = normalizeFindings(
    [{ category: 'dead_air', severity: 'medium', headline: 'Pause before read-back',
       detail: 'There was a five second pause before the agent read the registration back.' }],
    ctx,
  );
  assert.equal(out.length, 0);
});

test('a caller interrupting is never a fault', () => {
  const out = normalizeFindings(
    [{ category: 'other', severity: 'low', headline: 'Agent cut off',
       detail: 'The agent was interrupted by the caller mid-sentence.' }],
    ctx,
  );
  assert.equal(out.length, 0);
});

test('findings are capped so one call cannot flood the page', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({
    category: 'other', severity: 'low', headline: `h${i}`, detail: `detail ${i}`,
  }));
  assert.ok(normalizeFindings(many, ctx).length <= 6);
});

test('the high-severity findings survive the cap', () => {
  const mixed = [
    ...Array.from({ length: 10 }, (_, i) => ({ category: 'other', severity: 'low', headline: 'l', detail: `low ${i}` })),
    { category: 'wrong_info', severity: 'high', headline: 'Gave a wrong price', detail: 'Quoted £40 for an MOT the garage charges £54 for.' },
  ];
  const out = normalizeFindings(mixed, ctx);
  assert.ok(out.some((f) => f.severity === 'high'), 'the high finding must not be cut');
  assert.equal(out[0].severity, 'high', 'and it must come first');
});

test('the vocabulary is a closed set the page can group by', () => {
  assert.ok(FAULT_CATEGORIES.includes('dead_air'));
  assert.ok(FAULT_CATEGORIES.includes('other'));
  assert.ok(FAULT_CATEGORIES.every((c) => /^[a-z_]+$/.test(c)));
});
