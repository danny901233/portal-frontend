/**
 * WhatsApp send-capability check for agent-watchdog.cjs.
 *
 * Run from the backend dir:  node scripts/test-watchdog-wa-health.cjs
 *
 * Same discipline as test-watchdog-tts.cjs: temp state file, no auto-run, no database, no real
 * alert channels.
 *
 * WHY THIS CHECK EXISTS. 20 Oct 2026 07:15 → 21 Oct 21:00, EAC Telford: every WhatsApp reply
 * failed and nothing alerted for 38 hours. Six customers wrote in and got total silence — Josh,
 * Roger Thomas, Mike, Eiman, Jack Binnall (mid-MOT-booking, reg already given) and Mark Kettle.
 * Eight replies were written into the portal and shown to staff as sent; none left the building.
 *
 * checkWhatsAppTokens did not fire, and could not have: the token was valid, debug_token listed
 * the right WABA, GET /{phone_number_id} returned +44 1952 585511 with quality_rating GREEN, and
 * the number read CONNECTED / CLOUD_API. Every signal it looks at was healthy. The send itself
 * returned nothing but `500 {"code":1,"message":"An unknown error has occurred."}` on v18, v21
 * and v23 alike.
 *
 * Only ONE endpoint tells the truth — `?fields=health_status` — and it said can_send_message
 * BLOCKED, error 141008 "The WABA status is not active", because EAC's WABA fell back on their
 * own unverified business when they took full control of their Facebook account. So the rule is:
 * ask whether the number can SEND, never infer it from the token or the number reading healthy.
 */
const assert = require('node:assert').strict;
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-wa-'));
process.env.WATCHDOG_LASTRUN_FILE = path.join(tmp, 'lastrun.json');
delete process.env.HC_PING_URL;
process.env.WATCHDOG_NO_AUTORUN = '1';

const { waHealthIssues } = require('../agent-watchdog.cjs');

// Verbatim from EAC Telford, 21 Oct 2026 21:10 BST, GET /v21.0/1240009952520643?fields=health_status
const EAC_BLOCKED = {
  can_send_message: 'BLOCKED',
  entities: [
    { entity_type: 'PHONE_NUMBER', id: '1240009952520643', can_send_message: 'LIMITED',
      additional_info: ['Your display name has not been approved yet.'] },
    { entity_type: 'WABA', id: '27119328457763138', can_send_message: 'BLOCKED',
      errors: [{ error_code: 141008, error_description: 'The WABA status is not active.',
                 possible_solution: 'Please contact the WhatsApp support team to activate the account.' }] },
    { entity_type: 'BUSINESS', id: '1272279551429657', can_send_message: 'LIMITED',
      errors: [{ error_code: 141010, error_description: 'The Business has not passed business verification.' }] },
    { entity_type: 'APP', id: '1600229954436428', can_send_message: 'AVAILABLE' },
  ],
};

const HEALTHY = {
  can_send_message: 'AVAILABLE',
  entities: [
    { entity_type: 'PHONE_NUMBER', id: '111', can_send_message: 'AVAILABLE' },
    { entity_type: 'WABA', id: '222', can_send_message: 'AVAILABLE' },
    { entity_type: 'BUSINESS', id: '333', can_send_message: 'AVAILABLE' },
    { entity_type: 'APP', id: '1600229954436428', can_send_message: 'AVAILABLE' },
  ],
};

// 1. The outage this check exists for must be caught, and say what is wrong and whose it is.
{
  const got = waHealthIssues('EAC Telford', 'gid-eac', EAC_BLOCKED);
  assert.equal(got.length, 1, 'one issue per connection, not one per entity');
  assert.equal(got[0].key, 'wa-health:gid-eac');
  assert.match(got[0].msg, /EAC Telford/);
  assert.match(got[0].msg, /cannot send/i);
  assert.match(got[0].msg, /141008/, 'the Meta error code is what makes this searchable');
  assert.match(got[0].msg, /not active/i);
  // Whose problem it is decides who gets chased, so it has to be in the alert.
  assert.match(got[0].msg, /garage.s own Meta account/i);
  assert.doesNotMatch(got[0].msg, /\.\./, "no double full stop from Meta's own punctuation");
  console.log('ok  blocked WABA is caught and attributed\n    ' + got[0].msg);
}

// 2. A healthy connection must stay silent, or the alert becomes noise and gets ignored.
{
  assert.deepEqual(waHealthIssues('Healthy Garage', 'gid-ok', HEALTHY), []);
  console.log('ok  healthy connection is silent');
}

// 3. Our own app being blocked is OUR emergency, and must not read as the garage's fault.
{
  const ours = JSON.parse(JSON.stringify(HEALTHY));
  ours.can_send_message = 'BLOCKED';
  ours.entities[3] = { entity_type: 'APP', id: '1600229954436428', can_send_message: 'BLOCKED',
    errors: [{ error_code: 141009, error_description: 'The app is not active.' }] };
  const got = waHealthIssues('Any Garage', 'gid-app', ours);
  assert.equal(got.length, 1);
  assert.match(got[0].msg, /OUR app/i, 'an app-level block affects every garage at once');
  assert.doesNotMatch(got[0].msg, /garage's own Meta account/i);
  console.log('ok  an app-level block is attributed to us\n    ' + got[0].msg);
}

// 4. LIMITED is a warning, not an outage — messages still send, so it must not page anyone.
{
  const limited = JSON.parse(JSON.stringify(HEALTHY));
  limited.can_send_message = 'LIMITED';
  limited.entities[2] = { entity_type: 'BUSINESS', id: '333', can_send_message: 'LIMITED',
    errors: [{ error_code: 141010, error_description: 'The Business has not passed business verification.' }] };
  assert.deepEqual(waHealthIssues('Limited Garage', 'gid-lim', limited), [],
    'LIMITED still sends — alerting on it would cry wolf on half the estate');
  console.log('ok  LIMITED does not alert');
}

// 5. Meta not returning the field must never invent an outage.
{
  assert.deepEqual(waHealthIssues('X', 'gid-x', undefined), []);
  assert.deepEqual(waHealthIssues('X', 'gid-x', {}), []);
  assert.deepEqual(waHealthIssues('X', 'gid-x', { can_send_message: 'AVAILABLE' }), []);
  console.log('ok  a missing or partial payload is not an outage');
}

console.log('\nall wa-health checks passed');
