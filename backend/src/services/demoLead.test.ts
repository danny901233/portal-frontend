import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  demoCallNote,
  demoContactName,
  demoLeadTags,
  demoOpportunityName,
  displayUkPhone,
  droppedCallNote,
  isOurOwnNumber,
  leadIdFromRoomName,
} from './demoLead.js';
import { DID, FROM } from './highlevelTags.js';

// Adrian's call on 27 Oct is the worked example throughout: +44 7989 582725 rang the demo line
// three times in two minutes, gave his first name, asked about a touch-up, and left no trace in
// the CRM at all. Everything below is what should have been written about him.

test('the name the agent heard is what the contact is called', () => {
  assert.equal(demoContactName({ heardName: 'Adrian', callerPhone: '+447989582725' }), 'Adrian');
});

test('a caller who gave no name is named after their number, so they are still searchable', () => {
  assert.equal(demoContactName({ callerPhone: '+447989582725' }), 'Demo caller 07989 582725');
  assert.equal(demoContactName({ heardName: '   ', callerPhone: '+441708985485' }), 'Demo caller 01708 985485');
});

test('a browser demo falls back to the name or business from the CTA that gated it', () => {
  assert.equal(
    demoContactName({ lead: { name: 'Nick Patel', email: 'nick@x.co.uk', businessName: 'Thompson Service Centre' } }),
    'Nick Patel',
  );
  assert.equal(
    demoContactName({ lead: { name: null, email: 'info@x.co.uk', businessName: 'Thompson Service Centre' } }),
    'Thompson Service Centre',
  );
  // Nothing at all: a contact cannot be created from this, and pushDemoLead skips it rather than
  // inventing a row nobody can ring.
  assert.equal(demoContactName({}), 'Demo caller');
});

test('UK numbers are shown the way the team dials them, and anything else is left alone', () => {
  assert.equal(displayUkPhone('+447989582725'), '07989 582725');
  assert.equal(displayUkPhone('07989582725'), '07989 582725');
  assert.equal(displayUkPhone('+13105551234'), '+13105551234');
  assert.equal(displayUkPhone(null), '');
});

test('the opportunity name says what they did, so the board reads without opening cards', () => {
  assert.equal(demoOpportunityName('Adrian', 'phone', true), 'Adrian — tried the demo (phone)');
  assert.equal(demoOpportunityName('Adrian', 'web', true), 'Adrian — tried the demo (web)');
  assert.equal(demoOpportunityName('Adrian', 'phone', false), 'Adrian — rang the demo line, hung up');
});

test('a demo that got going is tagged differently from one that was dropped', () => {
  assert.deepEqual(demoLeadTags('phone', true), [FROM.demoLine, DID.demo]);
  assert.deepEqual(demoLeadTags('web', true), [FROM.webDemo, DID.demo]);
  assert.deepEqual(demoLeadTags('phone', false), [FROM.demoLine, DID.demoDropped]);
});

test('the note carries what they asked for, not just that they called', () => {
  const note = demoCallNote({
    via: 'phone',
    callerPhone: '+447989582725',
    heardName: 'Adrian',
    durationSeconds: 95,
    summary: 'Adrian called to request a touch-up job on his car.',
    callId: '59314058',
  });
  assert.match(note, /Rang the demo line — the call lasted 1m 35s\./);
  assert.match(note, /Gave the name: Adrian/);
  assert.match(note, /Called from: 07989 582725/);
  assert.match(note, /touch-up job/);
  assert.match(note, /\/calls\/59314058$/);
});

test('a booking taken on the demo leads the note', () => {
  const note = demoCallNote({
    via: 'web',
    durationSeconds: 35,
    confirmedBooking: true,
    bookingDetails: 'MOT booked for Monday 29th at 08:00',
    registrationNumber: 'KX20HGF',
  });
  assert.match(note, /^Tried the demo in the browser — the call lasted 35s\.\nBOOKED: MOT booked/);
  assert.match(note, /Registration: KX20HGF/);
});

test('a dropped call says how short it was and that the number is worth ringing', () => {
  const note = droppedCallNote('+447989582725', 15);
  assert.match(note, /hung up after 15s/);
  assert.match(note, /07989 582725/);
  assert.match(note, /dialled the number off the website themselves/);
});

// The lead id travels on the room name because that is the only field that survives the trip from
// the token request to the Call row the agent posts back.
test('the lead id is read back off the room name', () => {
  assert.equal(
    leadIdFromRoomName('garage-c7f53608-b0eb-4bdd-93da-02f2875acd93_web_a1b2c3d4e5f6_lead-cmv8anjse00ws9nfm4ejjihmj'),
    'cmv8anjse00ws9nfm4ejjihmj',
  );
  assert.equal(leadIdFromRoomName('demo-a1b2c3d4_lead-cmv8anjse00ws9nfm4ejjihmj'), 'cmv8anjse00ws9nfm4ejjihmj');
});

// A SIP room carries the caller's number in exactly the same underscore-separated shape, and a
// plain web room carries nothing. Neither must be mistaken for a lead id.
test('a room with no lead id yields none', () => {
  assert.equal(leadIdFromRoomName('garage-c7f53608-b0eb-4bdd-93da-02f2875acd93_+447989582725_M5qyrsphfsLw'), null);
  assert.equal(leadIdFromRoomName('garage-c7f53608-b0eb-4bdd-93da-02f2875acd93_web_a1b2c3d4e5f6'), null);
  assert.equal(leadIdFromRoomName(null), null);
  assert.equal(leadIdFromRoomName('_lead-short'), null);
});

// Our own test calls must not become leads. Dan's mobile rings the demo line more often than any
// prospect does, and each of those would otherwise open an opportunity in the Hot stage.
test('our own numbers are recognised whatever format they are configured in', () => {
  const list = ['+447976500282', '07713505050'];
  assert.equal(isOurOwnNumber('+447976500282', list), true);
  assert.equal(isOurOwnNumber('07976500282', list), true);
  assert.equal(isOurOwnNumber('+447713505050', list), true);
  assert.equal(isOurOwnNumber('+447989582725', list), false);
  assert.equal(isOurOwnNumber(null, list), false);
  // An empty list must never match everything.
  assert.equal(isOurOwnNumber('+447989582725', []), false);
  assert.equal(isOurOwnNumber('+447989582725', ['', '   ']), false);
});
