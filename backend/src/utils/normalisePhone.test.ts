/**
 * One phone shape, or caller recognition silently matches nothing.
 *
 * The ingest normalises what Tyresoft's CSV holds; the lookup normalises what Twilio hands us
 * at call time. If those two disagree by one character the garage sees zero recognised callers
 * and no error anywhere says why.
 *
 * "0000000000" is here because it was a real bug found by running the ingest against a fixture:
 * it satisfied the "00 international prefix" rule as 00 + eight digits and was stored as
 * "+00000000", a number that is not a number. The repeated-digit guard catches that class —
 * a placeholder can satisfy almost any shape test, so it is checked once up front rather than
 * per rule.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalisePhone } from './normalisePhone.js';
const CASES: [string, string, string][] = [
  // input,                 expected,            why
  ['07700 900111',          '+447700900111',     'UK mobile, spaced'],
  ['01536 512233',          '+441536512233',     'UK landline'],
  ['+447700900222',         '+447700900222',     'already E.164'],
  ['447700900333',          '+447700900333',     '44 without plus'],
  ['7700900444',            '+447700900444',     'mobile missing leading 0'],
  ['00447925715454',        '+447925715454',     '00 international prefix'],
  ['  07700900777  ',       '+447700900777',     'padded'],
  ['1111111111111',         '',                  'junk — repeated digit'],
  ['0000000000',            '',                  'junk — all zeros'],
  ['00000000',              '',                  'junk — 8 zeros'],
  ['0',                     '',                  'junk — single zero'],
  ['',                      '',                  'empty'],
  ['N/A',                   '',                  'text'],
  ['+1 415 555 0100',       '+14155550100',      'US number, valid E.164'],
  ['0035318001234',         '+35318001234',      'Irish via 00 prefix'],
];
for (const [input, expected, why] of CASES) {
  test(`${why}: ${JSON.stringify(input)}`, () => {
    assert.equal(normalisePhone(input), expected);
  });
}
