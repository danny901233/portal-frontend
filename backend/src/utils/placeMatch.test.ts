/**
 * The demo agent states a garage's address and phone number as fact, so a wrong Google match is
 * worse than no match at all: the garage hears its own details given incorrectly in the first
 * minute of its own demo.
 *
 * Every case below is real. The accepted ones come from the 3,553-row October 2026 enrichment
 * (88% proven); the refused ones are the near-misses that pass casually and are wrong — the same
 * failure the prospecting matcher was tightened for after "Alex Caldwell" resolved to caldwell.com.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { addressHasPostcode, placeNameResembles } from './googlePlaces.js';

test('accepts a fuller trading name', () => {
  assert.ok(placeNameResembles('AD Car Care Wimbledon Limited', 'AD Car Care Ltd'));
  assert.ok(placeNameResembles('ashford mot centre limited', 'Ashford MOT Centre ltd'));
  assert.ok(placeNameResembles('autocourt limited', 'Autocourt Ltd'));
});

test('accepts an initialism Google has spaced out', () => {
  assert.ok(placeNameResembles('TLS Peacehaven', 'T L S Peacehaven Ltd'));
});

test('accepts a listing with extra descriptive tail', () => {
  assert.ok(placeNameResembles('auto expert service', 'Auto Expert, Garage, Car Service Repair Centre & Showroom'));
  assert.ok(placeNameResembles('autotechnik', 'AutoTechnik - BMW & MINI Specialists Castrol Service'));
});

test('refuses a different business that merely shares generic words', () => {
  // Real refusals from the October run. Each would have handed the agent someone else's address.
  assert.ok(!placeNameResembles('Think One Limited', 'Group 1 Ford Basingstoke'));
  assert.ok(!placeNameResembles('Cambrian Autoservices', "Shaw's Service Station"));
  assert.ok(!placeNameResembles('Cross Tyres & Auto', 'Tuf Treads Dyfed Ltd'));
});

test('refuses when the name has nothing distinctive left', () => {
  // "H Cars" vs "EJ Cars" scored 0.71 on edit distance and handed H Cars the wrong website.
  assert.ok(!placeNameResembles('H CARS LIMITED', 'EJ Cars Ltd'));
});

test('postcode comparison ignores the space', () => {
  assert.equal(addressHasPostcode('Ings View Garage, Main Road, BROUGH, HU15 2SL, UK', 'HU152SL'), 'full');
  assert.equal(addressHasPostcode('Ings View Garage, Main Road, BROUGH, HU152SL', 'HU15 2SL'), 'full');
});

test('falls back to the outward code, and refuses a different town', () => {
  assert.equal(addressHasPostcode('2 Weir Rd, London SW19 8UG, UK', 'SW19 4TP'), 'outward');
  assert.equal(addressHasPostcode('2 Weir Rd, London SW19 8UG, UK', 'M11 3LW'), 'none');
  assert.equal(addressHasPostcode('', 'HU15 2SL'), 'none');
});

test('refuses a generic listing name swallowed by containment', () => {
  // The security review's case: "Garage" is a substring of "Newtown Garage", and a listing with
  // nothing distinctive in its name is not evidence of anything.
  assert.ok(!placeNameResembles('Newtown Garage', 'Garage'));
  assert.ok(!placeNameResembles('Hilltop Motors', 'Motors'));
  // ...while a genuinely fuller or shorter trading name still passes.
  assert.ok(placeNameResembles('Hunters Garage', 'Hunters Garage Ltd'));
  assert.ok(placeNameResembles('Kestrels', 'Kestrels Motor Company'));
});
