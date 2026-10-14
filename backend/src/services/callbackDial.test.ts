import { test } from 'node:test';
import assert from 'node:assert/strict';

import { callbackRoomName, callerIdFor } from './callbackDial.js';

test('the room name carries the garage, the caller and the callback marker', () => {
  const room = callbackRoomName('11111111-2222-3333-4444-555555555555', '+447700900123');
  assert.match(room, /^garage-11111111-2222-3333-4444-555555555555_\+447700900123_cb[a-z0-9]+$/);
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
