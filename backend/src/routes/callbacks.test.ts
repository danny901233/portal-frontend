import { test } from 'node:test';
import assert from 'node:assert/strict';

import { londonDayKey, parseCallbackRequest } from './callbacks.js';

test('the day key is the London date, not the UTC one', () => {
  // 23:30 UTC on 13 Oct is 00:30 on 14 Oct British Summer Time. A UTC reading would put the
  // callback in the wrong day's bucket and hand the caller a second dial.
  assert.equal(londonDayKey(new Date('2026-10-13T23:30:00Z')), '2026-10-14');
  assert.equal(londonDayKey(new Date('2026-10-14T11:00:00Z')), '2026-10-14');
});

test('the day key is stable in winter, when London is UTC', () => {
  assert.equal(londonDayKey(new Date('2026-01-13T23:30:00Z')), '2026-01-13');
});

test('a well-formed report is accepted', () => {
  const parsed = parseCallbackRequest({
    garageId: 'abc123',
    callerPhone: '+447700900123',
    durationSeconds: 12,
    roomName: 'garage-abc123_+447700900123_x1',
    twilioCallSid: 'CA123',
  });
  assert.ok(parsed.ok);
  assert.equal(parsed.value.garageId, 'abc123');
  assert.equal(parsed.value.durationSeconds, 12);
  assert.equal(parsed.value.callerPhone, '+447700900123');
});

test('a report without a garage is rejected', () => {
  const parsed = parseCallbackRequest({ callerPhone: '+447700900123', durationSeconds: 12 });
  assert.equal(parsed.ok, false);
});

test('a report of a call that was not short is rejected', () => {
  // The agent only reports short calls. A longer one means something has gone wrong upstream,
  // and guessing would ring somebody who was already served.
  const parsed = parseCallbackRequest({ garageId: 'abc123', callerPhone: '+447700900123', durationSeconds: 45 });
  assert.equal(parsed.ok, false);
});

test('exactly 30 seconds is not short, matching the agents’ own threshold', () => {
  assert.equal(
    parseCallbackRequest({ garageId: 'abc123', callerPhone: '+447700900123', durationSeconds: 30 }).ok,
    false,
  );
  assert.equal(
    parseCallbackRequest({ garageId: 'abc123', callerPhone: '+447700900123', durationSeconds: 29 }).ok,
    true,
  );
});

test('a non-numeric duration is rejected rather than coerced', () => {
  const parsed = parseCallbackRequest({ garageId: 'abc123', callerPhone: '+447700900123', durationSeconds: 'short' });
  assert.equal(parsed.ok, false);
});

test('a negative duration is rejected', () => {
  const parsed = parseCallbackRequest({ garageId: 'abc123', callerPhone: '+447700900123', durationSeconds: -3 });
  assert.equal(parsed.ok, false);
});

test('a missing caller number is accepted and left for the policy to refuse', () => {
  // The endpoint still records a refused attempt, so "why was nobody rung back?" is answerable.
  const parsed = parseCallbackRequest({ garageId: 'abc123', durationSeconds: 4 });
  assert.ok(parsed.ok);
  assert.equal(parsed.value.callerPhone, null);
});

test('blank strings come through as null rather than as empty values', () => {
  const parsed = parseCallbackRequest({
    garageId: 'abc123',
    durationSeconds: 4,
    callerPhone: '   ',
    roomName: '',
    twilioCallSid: '  ',
  });
  assert.ok(parsed.ok);
  assert.equal(parsed.value.callerPhone, null);
  assert.equal(parsed.value.roomName, null);
  assert.equal(parsed.value.twilioCallSid, null);
});

test('a non-object body is rejected', () => {
  assert.equal(parseCallbackRequest(null).ok, false);
  assert.equal(parseCallbackRequest('garageId=abc').ok, false);
});

test('a fractional duration is floored rather than rejected', () => {
  const parsed = parseCallbackRequest({ garageId: 'abc123', durationSeconds: 12.7 });
  assert.ok(parsed.ok);
  assert.equal(parsed.value.durationSeconds, 12);
});
