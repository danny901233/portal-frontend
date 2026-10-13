import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isClockTime,
  toWireTime,
  normaliseTime,
  looksLikeVrm,
  isSlotInFuture,
} from './chatAgentBookar.js';

// ---------------------------------------------------------------------------
// Drop-off slot tokens
//
// Bookar's availability does not always answer with a clock time. EAC Telford's
// services 2 and 6 return "AM_DR" — an AM drop-off — for every open day, so for
// those services a token is the ONLY thing the diary ever offers.
//
// "AM_DR" is five characters, and the old wire-format test was `time.length === 5`,
// so it padded the token into "AM_DR:00" and posted that. Bookar replied
// 400 {"app_time":["Time has wrong format. Use one of these formats instead:
// hh:mm[:ss[.uuuuuu]]."]} and Mikey's £186 interim service died at the last step
// on 10 Oct, one message after he gave his email.
// ---------------------------------------------------------------------------

test('a clock time is a clock time, a drop-off token is not', () => {
  assert.equal(isClockTime('08:00'), true);
  assert.equal(isClockTime('08:15:00'), true);
  assert.equal(isClockTime('9:00'), true);

  assert.equal(isClockTime('AM_DR'), false);
  assert.equal(isClockTime('PM_DR'), false);
  assert.equal(isClockTime('AM_DROP'), false);
  assert.equal(isClockTime(''), false);
});

test('the wire format pads a real time and never touches a token', () => {
  assert.equal(toWireTime('08:00'), '08:00:00');
  assert.equal(toWireTime('08:15:00'), '08:15:00');
  // Single-digit hour: the old slice(0,5) turned "9:00:00" into "9:00:" — also invalid.
  assert.equal(toWireTime('9:00'), '09:00:00');
  assert.equal(toWireTime('9:00:00'), '09:00:00');

  // The regression itself: this must never become "AM_DR:00" again.
  assert.equal(toWireTime('AM_DR'), 'AM_DR');
  assert.notEqual(toWireTime('AM_DR'), 'AM_DR:00');
});

test('normalising a time leaves a drop-off token whole', () => {
  // "AM_DROP" would have been sliced down to "AM_DR" — a token mangled into a
  // different token, which then matches nothing in the availability cross-check.
  assert.equal(normaliseTime('AM_DROP'), 'AM_DROP');
  assert.equal(normaliseTime('AM_DR'), 'AM_DR');

  // Clock times still normalise to HH:MM, and a single-digit hour now pads, so
  // the LLM saying "9:00" matches the diary's "09:00:00" instead of being
  // rejected as a slot we never offered.
  assert.equal(normaliseTime('09:00:00'), '09:00');
  assert.equal(normaliseTime('9:00'), '09:00');
  assert.equal(normaliseTime('08:30'), '08:30');
});

test('a drop-off day is still in the future', () => {
  // An unparseable time must not be read as midnight, or every drop-off day gets
  // filtered out of availability and the agent offers nothing at all.
  const now = { date: '2026-10-12', minutes: 14 * 60 };
  assert.equal(isSlotInFuture('2026-10-13', 'AM_DR', now), true);
  assert.equal(isSlotInFuture('2026-10-12', 'AM_DR', now), true);
  assert.equal(isSlotInFuture('2026-10-11', 'AM_DR', now), false);
});

// ---------------------------------------------------------------------------
// Registration gate
//
// Every one of these strings was passed to bk_lookup_vehicle as a `vrm` by the
// live agent between 23 Sep and 6 Oct. Bookar 404s on all of them, and the agent
// then read the miss back to the customer as though we had checked their vehicle:
// "I'm sorry, but I couldn't find any information for your VW Touran" — to Aatif
// Janjua, who had never been asked for a registration at all.
// ---------------------------------------------------------------------------

test('a vehicle description is not a registration', () => {
  assert.equal(looksLikeVrm('2019 VW Touran 1.6 TDI'), false);
  assert.equal(looksLikeVrm('BMW 330E 2016'), false);
  assert.equal(looksLikeVrm('T4 TRANSPORTER'), false);
  assert.equal(looksLikeVrm('Renault Master 17'), false);
  assert.equal(looksLikeVrm('2018 qashqai'), false);
  assert.equal(looksLikeVrm('BMW 320i M Sport auto 1998cc'), false);
});

test('a real plate still gets through, however the customer typed it', () => {
  // Plates from this garage's own conversations, including the two that booked.
  assert.equal(looksLikeVrm('WM19 HZJ'), true);
  assert.equal(looksLikeVrm('sg17vly'), true);
  assert.equal(looksLikeVrm('NA14EWE'), true);
  assert.equal(looksLikeVrm('L88 DMS'), true);
  assert.equal(looksLikeVrm('re20 ust'), true);
  assert.equal(looksLikeVrm('CV57KUK'), true);
  assert.equal(looksLikeVrm('YT64 EDV'), true);
  // Dateless and private plates are shorter but still plates.
  assert.equal(looksLikeVrm('A1'), true);
  assert.equal(looksLikeVrm('K9 DAN'), true);
});

test('words with no digits, and digits with no letters, are not plates', () => {
  assert.equal(looksLikeVrm('MOT'), false);
  assert.equal(looksLikeVrm('service'), false);
  assert.equal(looksLikeVrm('07428245673'), false);
  assert.equal(looksLikeVrm(''), false);
});
