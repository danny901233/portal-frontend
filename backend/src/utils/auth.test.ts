/**
 * Staff are not in their own allow-list.
 *
 * Login widens RECEPTIONMATE_STAFF to every unarchived garage and bakes that list into a 7-day
 * JWT. A garage onboarded after someone signs in is therefore absent from their token, and a
 * guard written as `resolveAllowedGarages(user).includes(id)` refuses it.
 *
 * On 29 Oct 2026 that was GET /api/garages/<id>/agent-config returning 403 for Woodyard Garage
 * Redditch — created two days after the token was minted — while /messaging-access on the same
 * garage answered 304. Seven guards in config.ts and one in voicePreview.ts had the same shape.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { mayAccessGarage, resolveAllowedGarages } from './auth.js';
import { agentTypeForScript } from './agentType.js';

const STAFF = { role: 'RECEPTIONMATE_STAFF', garageIds: ['garage-known'] };
const OWNER = { role: 'GARAGE_OWNER', garageIds: ['garage-a', 'garage-b'] };

test('staff reach a garage that is not in their token — the Woodyard case', () => {
  // The exact failure: the id exists, the garage is live, the token predates it.
  assert.equal(mayAccessGarage(STAFF, 'garage-created-after-login'), true);
  // And the raw check is what refused it, so the regression stays visible.
  assert.equal(resolveAllowedGarages(STAFF).includes('garage-created-after-login'), false);
});

test('the role is checked BEFORE the list, because for staff the list is a stale snapshot', () => {
  assert.equal(mayAccessGarage({ role: 'RECEPTIONMATE_STAFF', garageIds: [] }, 'anything'), true);
  assert.equal(mayAccessGarage({ role: 'RECEPTIONMATE_STAFF' }, 'anything'), true);
});

test('a customer is still confined to their own garages', () => {
  assert.equal(mayAccessGarage(OWNER, 'garage-a'), true);
  assert.equal(mayAccessGarage(OWNER, 'garage-b'), true);
  assert.equal(mayAccessGarage(OWNER, 'someone-elses-garage'), false);
  assert.equal(mayAccessGarage({ role: 'GARAGE_OWNER', garageIds: [] }, 'garage-a'), false);
});

test('no user and no garage are both refusals, not waved through', () => {
  assert.equal(mayAccessGarage(undefined, 'garage-a'), false);
  assert.equal(mayAccessGarage(OWNER, null), false);
  assert.equal(mayAccessGarage(OWNER, undefined), false);
  assert.equal(mayAccessGarage(OWNER, ''), false);
  // A staff member with no garage on the request is still fine: the role decides, and these
  // routes read the id from the path, so an empty one cannot reach another tenant's data.
  assert.equal(mayAccessGarage(STAFF, null), true);
});

test('the single-garage legacy claim is honoured', () => {
  assert.equal(mayAccessGarage({ role: 'GARAGE_OWNER', garageId: 'garage-solo' }, 'garage-solo'), true);
  assert.equal(mayAccessGarage({ role: 'GARAGE_OWNER', garageId: 'garage-solo' }, 'garage-other'), false);
});

// ── agentType is derived, never defaulted ───────────────────────────────────────────────────

test('only the Assist script is assist; everything else books', () => {
  assert.equal(agentTypeForScript('Assist-agent'), 'assist');
  assert.equal(agentTypeForScript('unified-agent'), 'automate');
  assert.equal(agentTypeForScript('receptionmate-agent'), 'automate');
  assert.equal(agentTypeForScript('receptionmate-agent-v3'), 'automate');
});

test('an absent script does not fall back to assist', () => {
  // The column default is 'assist', which is what mislabelled every garage created through
  // Quick Onboard. Deriving from nothing must not reproduce it.
  assert.equal(agentTypeForScript(undefined), 'automate');
  assert.equal(agentTypeForScript(null), 'automate');
  assert.equal(agentTypeForScript(''), 'automate');
  assert.equal(agentTypeForScript('  '), 'automate');
});

test('VICPros and Woodyard both come out right now', () => {
  // VICPros: Automate on unified + GarageHive, read back as 'assist' on 29 Oct.
  assert.equal(agentTypeForScript('unified-agent'), 'automate');
  // Woodyard: unified + Bookar, same wrong label.
  assert.equal(agentTypeForScript('unified-agent'), 'automate');
});
