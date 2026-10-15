import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyToolResult, TOOL_FAILED_PREFIX } from './chatToolLog.js';

// ---------------------------------------------------------------------------
// Tool-result classification
//
// Chat tool handlers return a string of instructions for the model, not a result object, so
// before this they could not report a failure at all: `success` was computed from an `error`
// key, and a string never has one.
//
// On 14 Oct 2026 James asked Speedy Spanners' WhatsApp agent to book his Audi Q5 in for the
// Monday. select_service returned "No services loaded yet. Call confirm_vehicle first." — a dead
// end — and the model answered "Leave it with me, James, I'll get your front brake pads booked
// for Monday 19th October. Just a moment…" and ended the turn. No booking was made and he was
// never written to again. The tool call sat in the diagnostics as a green, successful row, so
// nothing flagged it. Hence the explicit prefix.
// ---------------------------------------------------------------------------

test('a TOOL_FAILED string is a failure, and the first line becomes the reason', () => {
  const r = classifyToolResult(
    `${TOOL_FAILED_PREFIX} could not load the service list for HK23ULO.\nSay: "Let me take your details."\nThen call take_message.`
  );
  assert.equal(r.success, false);
  assert.equal(r.errorMessage, 'could not load the service list for HK23ULO.');
});

test('the recoverable ALL-CAPS sentinels stay successful', () => {
  // These are normal conversational outcomes, not faults. Reclassifying them would bury the real
  // failures in noise — which is the whole point of the prefix being opt-in.
  for (const s of [
    'SERVICE_NOT_AVAILABLE: no brake pads in the catalogue.',
    'NO_SERVICE_MATCH',
    'SERVICES_ALREADY_LOADED: MOT Class 4, Full Service.',
    'VEHICLE_AND_SERVICE_SET.',
    'INTERNAL: sessionId was missing. Call lookup_vehicle now.',
    'Vehicle found: Audi Q5 (HK23ULO).',
    '',
  ]) {
    assert.equal(classifyToolResult(s).success, true, `expected success for: ${s}`);
    assert.equal(classifyToolResult(s).errorMessage, null);
  }
});

test('the prefix only counts at the start, not anywhere in the text', () => {
  const r = classifyToolResult(`Say: "we never use the words ${TOOL_FAILED_PREFIX} to a customer."`);
  assert.equal(r.success, true);
});

test('an object with an error key is still a failure', () => {
  const r = classifyToolResult({ error: 'tool threw: ECONNRESET' });
  assert.equal(r.success, false);
  assert.equal(r.errorMessage, 'tool threw: ECONNRESET');
});

test('an error key with no usable value still reports something', () => {
  assert.equal(classifyToolResult({ error: null }).errorMessage, 'unknown error');
  assert.equal(classifyToolResult({ error: '' }).errorMessage, 'unknown error');
});

test('ordinary results and empty-ish values are successful', () => {
  for (const v of [null, undefined, 0, { slots: {} }, { total: 78 }]) {
    assert.equal(classifyToolResult(v).success, true);
  }
});

test('a long reason is capped so one tool call cannot bloat the row', () => {
  const r = classifyToolResult(`${TOOL_FAILED_PREFIX} ${'x'.repeat(900)}`);
  assert.equal(r.success, false);
  assert.equal(r.errorMessage!.length, 500);
});
