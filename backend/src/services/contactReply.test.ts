import { test } from 'node:test';
import assert from 'node:assert/strict';

import { surnameFromReply } from './contactReply.js';

// Speedy Spanners, 19 Oct 2026 (conversation cmvf3gk6l0d0uswt1t2uyxsr6). The agent asked for a
// surname, Katherine answered "Ractliffe", and the contact fastpath — which parses phone, email,
// postcode and house number only — threw it away. Garage Hive holds her as "Katherine Customer".
test('a bare surname is taken', () => {
  assert.equal(surnameFromReply('Ractliffe'), 'Ractliffe');
});

test('a lead-in is stripped', () => {
  assert.equal(surnameFromReply("It's Ractliffe"), 'Ractliffe');
});

test('"my surname is" is stripped', () => {
  assert.equal(surnameFromReply('my surname is O’Brien'), 'O’Brien');
});

test('a double-barrelled surname survives', () => {
  assert.equal(surnameFromReply('Smith-Jones'), 'Smith-Jones');
});

test('a surname in two words survives', () => {
  assert.equal(surnameFromReply('Van Der Berg'), 'Van Der Berg');
});

// These arrive at the same step and must not be stored as a surname.
test('a confirmation is not a surname', () => {
  assert.equal(surnameFromReply('yes'), null);
});

test('a refusal is not a surname', () => {
  assert.equal(surnameFromReply("I'd rather not say"), null);
});

test('an email address is not a surname', () => {
  assert.equal(surnameFromReply('katherineractliffe6@gmail.com'), null);
});

test('a postcode is not a surname', () => {
  assert.equal(surnameFromReply('PO6 1PY'), null);
});

test('a house number is not a surname', () => {
  assert.equal(surnameFromReply('209'), null);
});

test('a registration is not a surname', () => {
  assert.equal(surnameFromReply('YA73WKB'), null);
});

test('a question is not a surname', () => {
  assert.equal(surnameFromReply('can I add an MOT to that?'), null);
});

test('a thank-you is not a surname', () => {
  assert.equal(surnameFromReply('thanks'), null);
});

test('an empty reply is not a surname', () => {
  assert.equal(surnameFromReply(''), null);
});
