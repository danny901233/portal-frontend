import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildConnectRequestEmail, buildGettingReadyEmail } from './diaryConnect.js';

// These emails go to our integration partners — Garage Hive, Tyresoft, Bookar, AutoSage — from
// our own domain, and they carry a garage name. Since self-serve signup exists that name is typed
// by whoever is signing up, so it is untrusted input rendered into a message the recipient has
// every reason to trust. Unescaped, a name was markup.

const MALICIOUS = '"><a href="https://evil.example/login">Click to verify</a><!--';

test('a garage name cannot inject markup into the provider email', () => {
  const { html } = buildConnectRequestEmail('tyresoft', MALICIOUS, [MALICIOUS], 'https://portal.example/x');
  assert.ok(!html.includes('<a href="https://evil.example/login">'), 'injected anchor survived into the HTML');
  assert.ok(html.includes('&lt;a href=&quot;https://evil.example/login&quot;&gt;'), 'the name should appear escaped');
});

test('the escaping covers branch names as well as the business name', () => {
  const { html } = buildConnectRequestEmail('bookar', 'Fine Garage', ['Branch A', '<script>alert(1)</script>'], 'https://portal.example/x');
  assert.ok(!html.includes('<script>'), 'a branch name injected a script tag');
});

test('a garage name cannot inject markup into the customer getting-ready email', () => {
  const { html } = buildGettingReadyEmail('poole', MALICIOUS);
  assert.ok(!html.includes('<a href="https://evil.example/login">'));
});

// …but escaping is an HTML concern only. Ampersands and apostrophes are ordinary in UK garage
// names ("Smith & Sons", "O'Brien's"), and a text/plain body has no markup to inject — so
// escaping there would just show the partner "&amp;".

test('the plain-text body keeps the name readable', () => {
  const { text } = buildConnectRequestEmail('tyresoft', 'Smith & Sons', ["O'Brien's Garage"], 'https://portal.example/x');
  assert.ok(text.includes('Smith & Sons'), text.slice(0, 120));
  assert.ok(!text.includes('&amp;'), 'the text part should not be HTML-escaped');
});

test('the HTML body does escape an ordinary ampersand', () => {
  const { html } = buildConnectRequestEmail('bookar', 'Smith & Sons', ['Smith & Sons'], 'https://portal.example/x');
  assert.ok(html.includes('Smith &amp; Sons'));
});

// The Tyresoft SFTP folder names are slugified, so they should never carry markup anyway — this
// pins that the text version still prints a usable folder name rather than an escaped one, since
// the whole point of naming it is that it must match EXACTLY.

test('the Tyresoft folder name stays copy-pasteable in the text body', () => {
  const { text } = buildConnectRequestEmail('tyresoft', 'Lurgan Tyre Centre', ['Lurgan Tyre Centre'], 'https://portal.example/x');
  assert.ok(text.includes('lurgan-tyre-centre/'), text.slice(0, 400));
});
