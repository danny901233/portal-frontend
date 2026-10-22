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

import { normalizeFindings, FAULT_CATEGORIES, findCallFaults } from './callFaults.js';

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

test('a complaint about the summary\'s wording is dropped', () => {
  // Reviewing a prose summary against a transcript produced 39 findings on 124
  // calls, and the two I checked by hand were both wrong: 44742279 reported the
  // summary as falsely claiming no service history when the agent had said
  // exactly that, and 41254105 as carrying a wrong registration and date when
  // every detail matched. A summary is lossy by design; comparing it to a
  // transcript generates endless near-misses.
  // `summary_wrong` is deliberately no longer in the vocabulary, so the literal
  // is passed as unknown — exactly how a model that keeps using the old name
  // would deliver it.
  const stale: unknown[] = [{
    category: 'summary_wrong', severity: 'medium', headline: 'Summary misstates intent',
    detail: 'The summary describes the caller as asking about a service when they asked about an MOT.',
  }];
  const out = normalizeFindings(stale, ctx);
  assert.equal(out.length, 0);
});

test('a promise the tools never kept IS kept — that is the checkable version', () => {
  // Call 39952808: the garage was told a message had been taken for the team to
  // call Simon back, and take_message never completed.
  const out = normalizeFindings(
    [{ category: 'promise_not_kept', severity: 'high', headline: 'Garage told a message was taken',
       detail: 'The summary says a message was taken for the team to call back, but take_message ended at CONFIRM_NUMBER and no message was recorded.' }],
    ctx,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].category, 'promise_not_kept');
});

// ── the garage's own script is never a fault ──────────────────────────────
//
// Elite Autocare call 29225395, 22 Oct 2026. Flagged HIGH, "told the caller
// something untrue", for reciting the garage's alignment pricing. The garage's
// custom rule tells it to say exactly that, nearly word for word:
//
//   "We start with a full alignment diagnostic for £20 — that checks all the
//    angles on your wheels against the manufacturer's specification... If an
//    adjustment IS needed, the £20 diagnostic charge is REMOVED and replaced
//    by the alignment cost."
//
// Dan: "the agent correctly followed the garages rules".
//
// The analyst had no idea the rule existed — the same mistake as the Elite
// Autocare drop-off calls, judging the agent against something the judge was
// never given. The rules now go into its context, AND a finding quoting them
// back is dropped here, because a prompt has not held yet.
const ALIGNMENT_RULE = 'WHEEL ALIGNMENT / TRACKING — how the pricing works, explain it in this order: '
  + '1. Always start with the diagnostic. "We start with a full alignment diagnostic for £20 — that '
  + "checks all the angles on your wheels against the manufacturer's specification.\" "
  + '2. If nothing needs adjusting, the £20 is all they pay. Say so, it reassures them. '
  + '3. If an adjustment IS needed, the £20 diagnostic charge is REMOVED and replaced by the '
  + 'alignment cost — it is not added on top. Front toe adjustment is £48.';

const RULED = { ...ctx, rules: [ALIGNMENT_RULE] };

test('a wrong_info finding that quotes the garage\'s own rule back is dropped', () => {
  const out = normalizeFindings(
    [{
      category: 'wrong_info', severity: 'high', headline: 'Stated alignment pricing as fact',
      detail: 'The agent told the caller the garage always starts with a full wheel alignment '
        + 'diagnostic for £20 and described a specific process and pricing.',
      evidence: 'We always start with a full wheel alignment diagnostic for £20, which checks all '
        + "the wheel angles against your car's specification. If nothing needs adjusting, that's "
        + 'all you pay. If an adjustment is needed, the £20 is removed and replaced by the '
        + 'alignment cost instead.',
    }],
    RULED,
  );
  assert.equal(out.length, 0);
});

test('a genuinely wrong price is still flagged when rules exist', () => {
  const out = normalizeFindings(
    [{
      category: 'wrong_info', severity: 'high', headline: 'Quoted the wrong MOT price',
      detail: 'The agent quoted £40 for an MOT. The garage charges £54.85.',
      evidence: 'An MOT with us is forty pounds.',
    }],
    RULED,
  );
  assert.equal(out.length, 1, 'a price that is not in any rule is still a fault');
});

test('a wrong_info finding with no rules configured is untouched', () => {
  const out = normalizeFindings(
    [{ category: 'wrong_info', severity: 'high', headline: 'Invented a service',
       detail: 'The agent offered air conditioning regas, which this garage does not do.',
       evidence: 'Yes, we can do your air con regas.' }],
    ctx,
  );
  assert.equal(out.length, 1);
});

test('a finding about something OTHER than information is not excused by the rules', () => {
  // The rules say what to SAY. They do not excuse never recording the message.
  const out = normalizeFindings(
    [{ category: 'tool_failure', severity: 'medium', headline: 'Message never saved',
       detail: 'take_message ended at NEED_NAME and recorded nothing.',
       evidence: 'We start with a full alignment diagnostic for £20.' }],
    RULED,
  );
  assert.equal(out.length, 1);
});

test('a wrong_info finding with no evidence quoted is kept — there is nothing to match', () => {
  const out = normalizeFindings(
    [{ category: 'wrong_info', severity: 'medium', headline: 'Said something untrue',
       detail: 'The agent gave information that does not match the garage.' }],
    RULED,
  );
  assert.equal(out.length, 1);
});

test('the rules are put in front of the analyst, not only enforced after it', () => {
  // A guard that only fires afterwards still lets it waste a high-severity slot
  // and still reads as a judgement nobody asked for.
  const src = findCallFaults.toString();
  assert.ok(/rules/i.test(src), 'findCallFaults must build a rules block');
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
  // Widened to string[] because the literal is intentionally NOT a member —
  // that absence is what this line is asserting.
  assert.ok(!(FAULT_CATEGORIES as readonly string[]).includes('summary_wrong'),
            'summary prose review was dropped');
  assert.ok(FAULT_CATEGORIES.every((c) => /^[a-z_]+$/.test(c)));
});
