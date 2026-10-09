import { test } from 'node:test';
import assert from 'node:assert/strict';

import { callerNumberForStorage, isOwnGarageNumber } from './callerNumber.js';

// Advanced Service Centre: the line callers ring, and the line the agent transfers TO.
const ASC_MAIN = '+441268206600';
const ASC_TRANSFER = '+441375803104';
const ASC_OWN = [ASC_MAIN, ASC_TRANSFER];

test('a real caller number is stored as sent', () => {
  assert.equal(callerNumberForStorage('+447361892104', ASC_OWN), '+447361892104');
});

test('a withheld caller is stored as no number at all', () => {
  // What ASC saw on call 45674754: nothing to record, so record nothing.
  assert.equal(callerNumberForStorage(null, ASC_OWN), null);
  assert.equal(callerNumberForStorage('', ASC_OWN), null);
  assert.equal(callerNumberForStorage('anonymous', ASC_OWN), null);
  assert.equal(callerNumberForStorage('Anonymous', ASC_OWN), null);
  assert.equal(callerNumberForStorage('unknown', ASC_OWN), null);
  assert.equal(callerNumberForStorage('restricted', ASC_OWN), null);
  assert.equal(callerNumberForStorage('withheld', ASC_OWN), null);
  assert.equal(callerNumberForStorage('sip:anonymous@anonymous.invalid', ASC_OWN), null);
});

test("Twilio's keypad spelling of ANONYMOUS is not a phone number", () => {
  assert.equal(callerNumberForStorage('266696687', ASC_OWN), null);
});

test('a string with too few digits to ring back is not a number', () => {
  assert.equal(callerNumberForStorage('+', ASC_OWN), null);
  assert.equal(callerNumberForStorage('12345', ASC_OWN), null);
});

test("the garage's own transfer line is never the caller", () => {
  // The bug ASC reported: an anonymous caller was transferred, and the number the
  // agent dialled came back as the customer's. Ringing it reaches the garage itself.
  assert.equal(callerNumberForStorage(ASC_TRANSFER, ASC_OWN), null);
  assert.equal(callerNumberForStorage('01375803104', ASC_OWN), null);
  assert.equal(callerNumberForStorage('01375 803104', ASC_OWN), null);
  assert.equal(callerNumberForStorage('+441375803104', ASC_OWN), null);
});

test("the garage's own published line is never the caller either", () => {
  assert.equal(callerNumberForStorage(ASC_MAIN, ASC_OWN), null);
});

test('a garage with no numbers configured keeps every real number', () => {
  assert.equal(callerNumberForStorage('+447361892104', []), '+447361892104');
  assert.equal(callerNumberForStorage('+447361892104', [null, undefined, '']), '+447361892104');
});

test('own-number matching ignores formatting and dialling prefix', () => {
  assert.equal(isOwnGarageNumber('+441375803104', ASC_OWN), true);
  assert.equal(isOwnGarageNumber('01375803104', ASC_OWN), true);
  assert.equal(isOwnGarageNumber('00441375803104', ASC_OWN), true);
  assert.equal(isOwnGarageNumber('+447361892104', ASC_OWN), false);
});

test('a short own-number entry cannot match everything', () => {
  // Guard against an extension or a junk config value matching unrelated callers.
  assert.equal(isOwnGarageNumber('+447361892104', ['123']), false);
  assert.equal(isOwnGarageNumber('123', ['123']), false);
});
