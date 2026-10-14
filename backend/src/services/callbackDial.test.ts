import { test } from 'node:test';
import assert from 'node:assert/strict';

import { callbackRoomName, callerIdFor, isStaleAttempt } from './callbackDial.js';

test('the room name carries the garage, the caller and the callback marker', () => {
  const room = callbackRoomName('11111111-2222-3333-4444-555555555555', '+447700900123');
  assert.match(room, /^garage-11111111-2222-3333-4444-555555555555_\+447700900123_cbk_[a-z0-9]+$/);
});

// The agent parses the garage id and the caller's number straight out of the room name. If the
// marker broke either regex, every callback would boot with no garage config at all — no opening
// hours, no knowledge base, no diary credentials.
test('the room name still matches the agent’s own parsers', () => {
  const room = callbackRoomName('11111111-2222-3333-4444-555555555555', '+447700900123');
  const garageRe = /garage-([0-9a-fA-F-]{6,})/;
  const phoneRe = /garage-[0-9a-fA-F-]{8,}_+(\+?\d{6,})/;
  assert.equal(garageRe.exec(room)?.[1], '11111111-2222-3333-4444-555555555555');
  assert.equal(phoneRe.exec(room)?.[1], '+447700900123');
});

test('room names are unique per call', () => {
  const a = callbackRoomName('abc123', '+447700900123');
  const b = callbackRoomName('abc123', '+447700900123');
  assert.notEqual(a, b);
});

test('a verified caller ID is preferred', () => {
  const id = callerIdFor({
    outboundCallerId: '+441752123456',
    outboundCallerIdVerified: true,
    twilioNumber: '+443330411784',
  });
  assert.equal(id, '+441752123456');
});

// Only 2 of 63 garages are verified, so this is the common path, not the exception.
test('an unverified caller ID falls back to the garage’s Twilio number', () => {
  const id = callerIdFor({
    outboundCallerId: '+441752123456',
    outboundCallerIdVerified: false,
    twilioNumber: '+443330411784',
  });
  assert.equal(id, '+443330411784');
});

test('a garage with no usable number at all yields null', () => {
  assert.equal(
    callerIdFor({ outboundCallerId: null, outboundCallerIdVerified: false, twilioNumber: null }),
    null,
  );
});

// twilioNumber is stored for display — "+44 333 041 1784" — and no carrier presents it that way.
// Passing it through verbatim is what put four malformed numbers on the demo line's trunk.
test('the caller ID is normalised to E.164 digits', () => {
  const id = callerIdFor({
    outboundCallerId: null,
    outboundCallerIdVerified: false,
    twilioNumber: '+44 333 041 1784',
  });
  assert.equal(id, '+443330411784');
});

test('a verified but malformed caller ID falls back rather than being presented', () => {
  const id = callerIdFor({
    outboundCallerId: 'ask reception',
    outboundCallerIdVerified: true,
    twilioNumber: '+443330411784',
  });
  assert.equal(id, '+443330411784');
});

test('a national-format Twilio number is rejected rather than dialled as-is', () => {
  // E.164 or nothing: a bare 0333... in the From would be silently wrong on the wire.
  assert.equal(
    callerIdFor({ outboundCallerId: null, outboundCallerIdVerified: false, twilioNumber: '03330411784' }),
    null,
  );
});

// The marker is a segment of its own so an inbound room can never look like a callback. An
// inbound room is garage-<id>_<caller>_<rand>, and a random suffix beginning "cb" would have
// read as a callback about one call in 1,300 — greeting somebody who had just rung in with
// "we've just missed a call from you".
test('an inbound room whose random suffix starts with cb is not mistaken for a callback', () => {
  const inbound = 'garage-11111111-2222-3333-4444-555555555555_+447700900123_cb7x2a';
  assert.ok(!inbound.includes('_cbk_'), 'an inbound room must not contain the marker');

  const callback = callbackRoomName('11111111-2222-3333-4444-555555555555', '+447700900123');
  assert.ok(callback.includes('_cbk_'), 'a callback room must contain the marker');
});

// ── Staleness: a callback is only worth placing while it is still recent ────────────────────
//
// The sweep had no lower bound on dueAt. If the box is down from 17:05 to 09:00 — the memory
// leak outage, a DB OOM, a long deploy — every queued row dials the next morning and tells each
// customer "we've just missed a call from you" about a call from yesterday afternoon. The
// dial-time policy re-check does not catch it: by 09:00 the garage is open again.

test('a callback that has just come due is placed', () => {
  const now = new Date('2026-10-14T12:00:00Z');
  assert.equal(isStaleAttempt(new Date('2026-10-14T11:59:00Z'), now), false);
});

test('a callback is still worth placing a few minutes late', () => {
  const now = new Date('2026-10-14T12:00:00Z');
  assert.equal(isStaleAttempt(new Date('2026-10-14T11:52:00Z'), now), false);
});

test('a callback left overnight by an outage is abandoned, not placed', () => {
  const now = new Date('2026-10-14T09:00:00Z');
  assert.equal(isStaleAttempt(new Date('2026-10-13T17:05:00Z'), now), true);
});

test('the staleness boundary is 15 minutes', () => {
  const now = new Date('2026-10-14T12:00:00Z');
  assert.equal(isStaleAttempt(new Date('2026-10-14T11:45:30Z'), now), false);
  assert.equal(isStaleAttempt(new Date('2026-10-14T11:44:30Z'), now), true);
});
