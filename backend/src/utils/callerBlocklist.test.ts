import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isBlockedCaller, isWithheldCaller, normaliseCaller } from './callerBlocklist.js';

const DEMO = 'c7f53608-b0eb-4bdd-93da-02f2875acd93';
const REAL = '516d4585-24bb-4a90-b140-392f3944f47b';

test('a number is matched however it is written', () => {
  assert.equal(normaliseCaller('+447361892104'), '447361892104');
  assert.equal(normaliseCaller('+4473 6189 210 4'), '447361892104');
  assert.equal(normaliseCaller('07361 892104'), '447361892104');
  assert.equal(normaliseCaller('00447361892104'), '447361892104');
});

test('the blocked number is refused on the line it is scoped to', () => {
  const list = `+447361892104@${DEMO}`;
  assert.equal(isBlockedCaller('+447361892104', DEMO, list), true);
  assert.equal(isBlockedCaller('07361892104', DEMO, list), true);
});

test('a line-scoped block does not touch any other garage', () => {
  assert.equal(isBlockedCaller('+447361892104', REAL, `+447361892104@${DEMO}`), false);
});

test('an unscoped entry blocks the caller everywhere', () => {
  assert.equal(isBlockedCaller('+447361892104', REAL, '+447361892104'), true);
  assert.equal(isBlockedCaller('+447361892104', DEMO, '+447361892104'), true);
});

test('other callers get through', () => {
  assert.equal(isBlockedCaller('+447506629135', DEMO, `+447361892104@${DEMO}`), false);
});

test('an empty or unset blocklist blocks nobody', () => {
  assert.equal(isBlockedCaller('+447361892104', DEMO, ''), false);
  assert.equal(isBlockedCaller('+447361892104', DEMO, undefined), false);
});

test('every shape of withheld caller ID is recognised', () => {
  for (const from of [
    null, undefined, '', '   ',
    'anonymous', 'Anonymous', 'unknown', 'unavailable', 'restricted', 'private', 'blocked',
    'sip:anonymous@anonymous.invalid',
    '+266696687',               // Twilio's ANONYMOUS-on-a-keypad sentinel
  ]) {
    assert.equal(isWithheldCaller(from), true, `${String(from)} should read as withheld`);
  }
});

test('a real number is not withheld', () => {
  assert.equal(isWithheldCaller('+447361892104'), false);
  assert.equal(isWithheldCaller('+443330411784'), false);
});

test('withheld is refused only on the lines that ask for it', () => {
  const list = `withheld@${DEMO}`;
  assert.equal(isBlockedCaller('anonymous', DEMO, list), true);
  assert.equal(isBlockedCaller(null, DEMO, list), true);
  // A withheld number ringing a real garage is a real customer. It must still be answered.
  assert.equal(isBlockedCaller('anonymous', REAL, list), false);
  assert.equal(isBlockedCaller(null, REAL, list), false);
});

test('a withheld rule does not block callers who gave a number', () => {
  assert.equal(isBlockedCaller('+447361892104', DEMO, `withheld@${DEMO}`), false);
});

test('whitespace and casing in the env value are tolerated', () => {
  const list = ` +44 7361 892104 @ ${DEMO} ,  WITHHELD@${DEMO.toUpperCase()} `;
  assert.equal(isBlockedCaller('+447361892104', DEMO, list), true);
  assert.equal(isBlockedCaller('anonymous', DEMO, list), true);
  assert.equal(isBlockedCaller('+447506629135', DEMO, list), false);
});
