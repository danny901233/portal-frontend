import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decideCallback, type CallbackPolicyInput } from './callbackPolicy.js';

// A request that should be allowed. Each test changes one field.
const ok: CallbackPolicyInput = {
  enabledGlobally: true,
  garageEnabled: true,
  callerPhone: '+447700900123',
  garageOwnNumbers: ['+441375803104', '+443330411784'],
  blocked: false,
  openNow: true,
  originalWasCallback: false,
  newerLoggedCallFromNumber: false,
  garageAttemptsToday: 0,
  estateAttemptsToday: 0,
  garageDailyCap: 25,
  estateDailyCap: 150,
};

test('a plain short call from a normal number is allowed', () => {
  assert.deepEqual(decideCallback(ok), { allow: true });
});

// Review Focus 1. The infinite-redial defect: most callbacks end under 30 seconds themselves.
test('a call that was itself a callback is refused', () => {
  assert.deepEqual(decideCallback({ ...ok, originalWasCallback: true }), {
    allow: false,
    reason: 'was_callback',
  });
});

// Review Focus 2. Advanced Service Centre forward their landline and their carrier presents the
// forwarding number, so a whole day's callers can arrive as the garage's own line.
test("the garage's own number is never called back", () => {
  assert.deepEqual(decideCallback({ ...ok, callerPhone: '+441375803104' }), {
    allow: false,
    reason: 'garage_own_number',
  });
});

test("the garage's own number is matched on digits, not formatting", () => {
  assert.deepEqual(decideCallback({ ...ok, callerPhone: '+44 1375 803104' }), {
    allow: false,
    reason: 'garage_own_number',
  });
  assert.deepEqual(decideCallback({ ...ok, callerPhone: '01375803104' }), {
    allow: false,
    reason: 'garage_own_number',
  });
});

test("a garage's own number that is blank or junk never matches a real caller", () => {
  // An unset transferNumber must not make every caller look like the garage itself.
  assert.deepEqual(
    decideCallback({ ...ok, garageOwnNumbers: [null, '', '   ', undefined] }),
    { allow: true },
  );
});

// Review Focus 3. Withheld callers, including Twilio's "ANONYMOUS" spelled on a keypad.
test('withheld callers are refused rather than dialled literally', () => {
  for (const value of ['anonymous', 'unavailable', 'restricted', 'withheld', '266696687']) {
    assert.deepEqual(
      decideCallback({ ...ok, callerPhone: value }),
      { allow: false, reason: 'withheld' },
      `expected ${value} to be treated as withheld`,
    );
  }
});

test('an empty or missing number is refused', () => {
  assert.deepEqual(decideCallback({ ...ok, callerPhone: null }), { allow: false, reason: 'no_number' });
  assert.deepEqual(decideCallback({ ...ok, callerPhone: '   ' }), { allow: false, reason: 'no_number' });
});

test('a number under 7 digits reads as withheld, which is what the shared helper calls it', () => {
  assert.deepEqual(decideCallback({ ...ok, callerPhone: '+4477' }), { allow: false, reason: 'withheld' });
});

test('a number long enough to look real but too short to dial is refused', () => {
  assert.deepEqual(decideCallback({ ...ok, callerPhone: '123456789' }), {
    allow: false,
    reason: 'no_number',
  });
});

test('the kill switch beats the per-garage flag', () => {
  assert.deepEqual(decideCallback({ ...ok, enabledGlobally: false }), {
    allow: false,
    reason: 'kill_switch',
  });
});

test('a garage that has not opted in is refused', () => {
  assert.deepEqual(decideCallback({ ...ok, garageEnabled: false }), { allow: false, reason: 'flag_off' });
});

test('a blocklisted caller is refused', () => {
  assert.deepEqual(decideCallback({ ...ok, blocked: true }), { allow: false, reason: 'blocklisted' });
});

test('nobody is rung back out of hours', () => {
  assert.deepEqual(decideCallback({ ...ok, openNow: false }), { allow: false, reason: 'closed' });
});

test('a caller who has already rung back and been served is left alone', () => {
  assert.deepEqual(decideCallback({ ...ok, newerLoggedCallFromNumber: true }), {
    allow: false,
    reason: 'called_back_already',
  });
});

test('the per-garage daily cap is enforced at the boundary', () => {
  assert.deepEqual(decideCallback({ ...ok, garageAttemptsToday: 24 }), { allow: true });
  assert.deepEqual(decideCallback({ ...ok, garageAttemptsToday: 25 }), {
    allow: false,
    reason: 'garage_cap',
  });
});

test('the estate daily cap is enforced at the boundary', () => {
  assert.deepEqual(decideCallback({ ...ok, estateAttemptsToday: 149 }), { allow: true });
  assert.deepEqual(decideCallback({ ...ok, estateAttemptsToday: 150 }), {
    allow: false,
    reason: 'estate_cap',
  });
});

test('the kill switch is reported ahead of any other refusal', () => {
  // The reason recorded on the row is the FIRST gate that said no, which is what makes
  // "why has nothing dialled all morning?" answerable in one look.
  const everythingWrong = {
    ...ok,
    enabledGlobally: false,
    garageEnabled: false,
    callerPhone: null,
    blocked: true,
    openNow: false,
  };
  assert.deepEqual(decideCallback(everythingWrong), { allow: false, reason: 'kill_switch' });
});

test('the loop guard is checked before the number is looked at all', () => {
  // A callback to a withheld number must still report was_callback: the loop is the worse
  // failure, and it is the one we want named on the row.
  assert.deepEqual(
    decideCallback({ ...ok, originalWasCallback: true, callerPhone: 'anonymous' }),
    { allow: false, reason: 'was_callback' },
  );
});
