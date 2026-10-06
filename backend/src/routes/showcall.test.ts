import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CLIP,
  showcallClipKey,
  buildShowcallTwiml,
  buildUnavailableTwiml,
} from './showcall.js';

// ── showcallClipKey: which object a ?clip= may reach ────────────────────────
//
// The whole point of ?clip= is that a take can be swapped on the stand without a
// deploy, so the name comes off the query string. That makes it attacker-shaped
// input even though only we will ever type it: without a charset check a clip of
// '../../recordings/live-call' would presign somebody's real call recording and
// play it down the line.

test('no clip given falls back to the default take', () => {
  assert.equal(showcallClipKey(undefined), `showcall/${DEFAULT_CLIP}.mp3`);
  assert.equal(showcallClipKey(''), `showcall/${DEFAULT_CLIP}.mp3`);
});

test('an ordinary clip name resolves under the showcall prefix', () => {
  assert.equal(showcallClipKey('demo-call-short'), 'showcall/demo-call-short.mp3');
});

test('a clip name is lowercased so the webhook is not case-sensitive', () => {
  assert.equal(showcallClipKey('Demo-Call-Short'), 'showcall/demo-call-short.mp3');
});

test('path traversal is refused rather than escaping the prefix', () => {
  assert.equal(showcallClipKey('../../recordings/91920074'), null);
  assert.equal(showcallClipKey('foo/bar'), null);
  assert.equal(showcallClipKey('..'), null);
});

test('a name with unexpected characters is refused', () => {
  assert.equal(showcallClipKey('demo call'), null);
  assert.equal(showcallClipKey('demo_call.mp3'), null);
  assert.equal(showcallClipKey('x'.repeat(41)), null);
});

// ── buildShowcallTwiml ─────────────────────────────────────────────────────

test('the TwiML frames the clip, plays it, then hangs up', () => {
  const xml = buildShowcallTwiml({
    audioUrl: 'https://example.com/a.mp3',
    intro: 'Have a listen.',
    outro: 'Press the other button to try it.',
  });
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<Say voice="Polly\.Amy-Neural">Have a listen\.<\/Say>/);
  assert.match(xml, /<Play>https:\/\/example\.com\/a\.mp3<\/Play>/);
  assert.match(xml, /<Say voice="Polly\.Amy-Neural">Press the other button to try it\.<\/Say>/);
  assert.match(xml, /<Hangup\/>\s*<\/Response>$/);

  // Order matters: a <Say> after the <Play> only lands if it follows it.
  assert.ok(xml.indexOf('Have a listen') < xml.indexOf('<Play>'));
  assert.ok(xml.indexOf('<Play>') < xml.indexOf('Press the other button'));
});

test('an empty intro or outro is omitted rather than spoken as nothing', () => {
  const xml = buildShowcallTwiml({ audioUrl: 'https://example.com/a.mp3', intro: '', outro: '' });
  assert.ok(!xml.includes('<Say'));
  assert.match(xml, /<Play>/);
});

test('a presigned URL is escaped so its query string cannot break the XML', () => {
  // Presigned URLs always carry &-separated parameters. Interpolated raw, the
  // first bare & makes the document invalid and Twilio plays nothing at all.
  const xml = buildShowcallTwiml({
    audioUrl: 'https://s3.example.com/a.mp3?X-Amz-Signature=abc&X-Amz-Expires=3600',
    intro: '',
    outro: '',
  });
  assert.ok(xml.includes('X-Amz-Signature=abc&amp;X-Amz-Expires=3600'));
  // Nothing left over once the escaped ones are removed: no bare & anywhere.
  assert.ok(!xml.replace(/&amp;/g, '').includes('&'));
});

test('intro text is escaped too', () => {
  const xml = buildShowcallTwiml({
    audioUrl: 'https://example.com/a.mp3',
    intro: 'Smith & Sons <Hangup/>',
    outro: '',
  });
  assert.ok(xml.includes('Smith &amp; Sons &lt;Hangup/&gt;'));
});

// ── buildUnavailableTwiml ──────────────────────────────────────────────────
//
// A missing clip must say something. Returning an empty <Response> or a 500
// gives the visitor silence then a dead line, which at a trade show reads as
// "their product is broken".

test('an unavailable clip is spoken, not silent', () => {
  const xml = buildUnavailableTwiml();
  assert.match(xml, /<Say voice="Polly\.Amy-Neural">.+<\/Say>/);
  assert.match(xml, /<Hangup\/>/);
  assert.ok(!xml.includes('<Play>'));
});
