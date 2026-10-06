import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hasGarageAccess } from './garageAccess.js';

test('a manager reaches a garage on their access list', () => {
  assert.equal(hasGarageAccess({ role: 'MANAGER', garageAccessIds: ['g1', 'g2'] }, 'g1'), true);
});

test('a manager cannot reach another garage', () => {
  assert.equal(hasGarageAccess({ role: 'MANAGER', garageAccessIds: ['g1'] }, 'g2'), false);
});

test('ReceptionMate staff reach any garage', () => {
  assert.equal(hasGarageAccess({ role: 'RECEPTIONMATE_STAFF', garageAccessIds: [] }, 'g9'), true);
});

test('a user with no access list reaches nothing', () => {
  assert.equal(hasGarageAccess({ role: 'USER', garageAccessIds: [] }, 'g1'), false);
});

test('a missing user reaches nothing', () => {
  assert.equal(hasGarageAccess(null, 'g1'), false);
});
