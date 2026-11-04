import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  contactArgsForProspect,
  isDroppedProspectDial,
  prospectCallNote,
  prospectDroppedNote,
} from './prospectLead.js';

// A prospect with no CRM contact used to be skipped silently — Protyre Warwick, Sytner Swansea
// and Stellantis Nottingham all rang their own demo and existed nowhere afterwards. The contact
// is now made from what the row already holds: the garage's own name, Google phone and email.

test('a contact can be made from the garage phone alone', () => {
  const args = contactArgsForProspect({
    spokenName: 'Protyre Warwick',
    businessName: 'Protyre Warwick',
    email: null,
    phoneNumber: '01926 123456',
  });
  assert.ok(args);
  assert.equal(args.name, 'Protyre Warwick');
  assert.equal(args.phone, '01926 123456');
  assert.equal(args.email, undefined);
  assert.equal(args.source, 'own demo');
});

test('no email and no phone means no contact can be made', () => {
  assert.equal(
    contactArgsForProspect({ spokenName: 'X', businessName: 'X', email: null, phoneNumber: null }),
    null,
  );
  assert.equal(
    contactArgsForProspect({ spokenName: 'X', businessName: 'X', email: '  ', phoneNumber: '' }),
    null,
  );
});

// Twilio's <Dial action> reports every ended leg. Only a connected call that ended under the
// agent's 30-second logging floor is a hang-up worth a "rang and hung up" lead; a leg that never
// connected is our outage, not their decision, and a long call is the agent's to report.

test('a completed leg under thirty seconds is a dropped demo', () => {
  assert.equal(isDroppedProspectDial('completed', 12), true);
  assert.equal(isDroppedProspectDial('completed', 29), true);
});

test('a leg at or over the logging floor is left to the agent', () => {
  assert.equal(isDroppedProspectDial('completed', 30), false);
  assert.equal(isDroppedProspectDial('completed', 240), false);
});

test('a leg that never connected is not a hang-up', () => {
  assert.equal(isDroppedProspectDial('no-answer', 0), false);
  assert.equal(isDroppedProspectDial('failed', 0), false);
  assert.equal(isDroppedProspectDial('busy', 0), false);
  assert.equal(isDroppedProspectDial('completed', Number.NaN), false);
});

test('the call note says what they asked for and links their demo', () => {
  const note = prospectCallNote({
    slug: 'protyre-warwick-5ef1d49d89a333eb',
    durationSeconds: 95,
    summary: 'Asked for an MOT on Friday.',
    customerName: 'Abdul',
    registrationNumber: 'KX20HGF',
    bookingDetails: 'MOT Friday 10am',
    confirmedBooking: true,
  });
  assert.match(note, /call lasted 1m 35s/);
  assert.match(note, /BOOKED: MOT Friday 10am/);
  assert.match(note, /Gave the name: Abdul/);
  assert.match(note, /Registration: KX20HGF/);
  assert.match(note, /Asked for an MOT on Friday\./);
  assert.match(note, /\/try\/protyre-warwick-5ef1d49d89a333eb/);
});

test('the dropped note names the number and the demo link', () => {
  const note = prospectDroppedNote({
    slug: 'thompson-service-centre-9eaff2f181e82d63',
    callerPhone: '+447989582725',
    durationSeconds: 14,
  });
  assert.match(note, /hung up after 14s/);
  assert.match(note, /07989 582725/);
  assert.match(note, /\/try\/thompson-service-centre-9eaff2f181e82d63/);
});
