/**
 * Opening a call must not depend on which branch the header happens to be set to.
 *
 * Dan, 22 Oct 2026, on the /observability fault list: clicking a call id "currently does
 * [open it] but if we arent switched to that particular branch at the top it will give us
 * 'Unable to load this call. Request failed with status code 404'".
 *
 * The cause is that the page asked for /api/garages/<selected branch>/calls/<id>, so a call
 * belonging to a sibling branch simply is not there. Resolving the garage from the CALL means
 * the branch picker stops mattering — but only if the access check still comes from the user's
 * own garages and not from the call, which is what these tests pin down.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mayOpenCall } from './callAccess.js';

const STAFF = { role: 'RECEPTIONMATE_STAFF', garageIds: [] };
const OWNER = { role: 'GARAGE_OWNER', garageIds: ['branch-a', 'branch-b'] };

test('staff may open any call', () => {
  assert.equal(mayOpenCall(STAFF, 'someone-elses-garage'), true);
});

test('a user may open a call from any branch they have access to', () => {
  // The whole point: branch-b while the picker sits on branch-a.
  assert.equal(mayOpenCall(OWNER, 'branch-b'), true);
  assert.equal(mayOpenCall(OWNER, 'branch-a'), true);
});

test('a user may NOT open a call from a garage they have no access to', () => {
  assert.equal(mayOpenCall(OWNER, 'someone-elses-garage'), false);
});

test('a single-garage user is still resolved', () => {
  assert.equal(mayOpenCall({ role: 'GARAGE_OWNER', garageId: 'only-one' }, 'only-one'), true);
  assert.equal(mayOpenCall({ role: 'GARAGE_OWNER', garageId: 'only-one' }, 'another'), false);
});

test('a call with no garage on it is refused, never waved through', () => {
  assert.equal(mayOpenCall(OWNER, null), false);
  assert.equal(mayOpenCall(OWNER, undefined), false);
  assert.equal(mayOpenCall(OWNER, ''), false);
});

test('a missing user is refused', () => {
  assert.equal(mayOpenCall(undefined, 'branch-a'), false);
});

test('a user with no garages is refused even for a real call', () => {
  assert.equal(mayOpenCall({ role: 'GARAGE_OWNER', garageIds: [] }, 'branch-a'), false);
});

// Staff is decided on the ROLE, not on the garage list, so an empty list must not
// accidentally lock staff out — that is how the staff bypass is written everywhere else.
test('staff with no garages listed are still staff', () => {
  assert.equal(mayOpenCall({ role: 'RECEPTIONMATE_STAFF' }, 'anything'), true);
});
