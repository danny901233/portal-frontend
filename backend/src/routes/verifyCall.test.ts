import { test } from 'node:test';
import assert from 'node:assert/strict';

import { forwardTwiml, FORWARD_TO_ENV } from './verifyCall.js';

// ---------------------------------------------------------------------------
// Catching a WhatsApp verification code read down the phone
//
// +443330386043 is the group WhatsApp number for The Gearbox Centre's five branches, bought
// 2026-10-22. Twilio GB non-geographic numbers are voice-only — capabilities.sms is false — so
// Meta cannot text the one-time code during WhatsApp setup and has to call and read it aloud.
// The number had no voice_url at all, so that call would have rung out and setup would have
// stalled with no way to see why.
//
// Forwarding rather than recording-and-transcribing on purpose: a human on the line hears six
// spoken digits correctly first time, and our own transcription notes are full of digits and
// letters being misheard.
// ---------------------------------------------------------------------------

test('the forward dials the configured number and keeps the 0333 as caller id', () => {
  const xml = forwardTwiml('+447976500282', '+443330386043');
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<Response>/);
  assert.match(xml, /<Dial[^>]*callerId="\+443330386043"[^>]*>\+447976500282<\/Dial>/);
});

test('with nothing configured it says so rather than dropping the call silently', () => {
  // A silent hang-up here looks identical to "Meta never called", which is the one thing that
  // would make this impossible to debug while someone sits in front of the setup screen.
  const xml = forwardTwiml('', '+443330386043');
  assert.doesNotMatch(xml, /<Dial/);
  assert.match(xml, /<Say/);
  assert.match(xml, /not configured/i);
});

test('a configured number with spaces or a leading zero is normalised to E.164', () => {
  assert.match(forwardTwiml(' +44 7976 500282 ', '+443330386043'), /<Dial[^>]*>\+447976500282</);
  assert.match(forwardTwiml('07976500282', '+443330386043'), /<Dial[^>]*>\+447976500282</);
});

test('anything that is not a dialable number is refused, not interpolated into TwiML', () => {
  // The forward target comes from env, but TwiML is XML: a stray '"' or '<' would produce a
  // malformed document and Twilio would fail the call with a 12100 rather than say anything.
  for (const bad of ['not-a-number', '<Dial>evil</Dial>', '+44"', 'tel:+447976500282']) {
    const xml = forwardTwiml(bad, '+443330386043');
    assert.doesNotMatch(xml, /<Dial/, `${bad} must not be dialled`);
    assert.doesNotMatch(xml, /evil/);
  }
});

test('the env var name is the one the deploy sets', () => {
  assert.equal(FORWARD_TO_ENV, 'VERIFY_CALL_FORWARD_TO');
});
