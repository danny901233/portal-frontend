import { test } from 'node:test';
import assert from 'node:assert/strict';

import { catalogueFallbacks, matchingDirective } from './bookarServiceMatch.js';

// EAC Telford's real Bookar catalogue, 20 Oct 2026 (from bk_list_services on HD16 HCL).
const EAC = [
  { id: 23, name: 'Hybrid & Electric Car Servicing', type: 'QUOTE', price_numeric: 0 },
  { id: 25, name: 'Engine Issue', type: 'FREE', price_numeric: 0 },
  { id: 28, name: '4 Wheel Alignment', type: 'FIXED', price_numeric: 102 },
  { id: 29, name: 'Dealer Car Service', type: 'MATRIX', price_numeric: 0 },
  { id: 141, name: 'Others', type: 'FIXED', price_numeric: 0 },
  { id: 10, name: 'Air Conditioning Service (R134a Gas)', type: 'FIXED', price_numeric: 88.8 },
  { id: 119, name: 'Interim Service', type: 'MATRIX', price_numeric: 197.47 },
  { id: 120, name: 'Full Service', type: 'MATRIX', price_numeric: 306.17 },
  { id: 9, name: 'MOT Class 4 (Car & Small/Medium Van)', type: 'FIXED', price_numeric: 54.85 },
  { id: 5, name: 'Diagnostic Assessment', type: 'FIXED', price_numeric: 173.81 },
  { id: 43, name: 'Hybrid Diagnostic Assessment', type: 'FIXED', price_numeric: 185.89 },
  { id: 44, name: 'Full EV Diagnostic Assessment', type: 'FIXED', price_numeric: 209.34 },
];

// A garage with nothing to fall back on.
const BARE = [
  { id: 1, name: 'MOT Class 4', type: 'FIXED', price_numeric: 54.85 },
  { id: 2, name: 'Full Service', type: 'MATRIX', price_numeric: 299 },
];

test('the free triage slot is found', () => {
  assert.deepEqual(catalogueFallbacks(EAC).triage, { id: 25, name: 'Engine Issue' });
});

test('the paid diagnostic is found', () => {
  assert.deepEqual(catalogueFallbacks(EAC).diagnostic, { id: 5, name: 'Diagnostic Assessment' });
});

// EAC has three. A petrol Mondeo must not be offered the EV one.
test('the plain diagnostic wins over the hybrid and EV variants', () => {
  assert.equal(catalogueFallbacks(EAC).diagnostic?.id, 5);
});

test('the catch-all is found', () => {
  assert.deepEqual(catalogueFallbacks(EAC).catchAll, { id: 141, name: 'Others' });
});

test('a bare catalogue has no fallbacks', () => {
  assert.deepEqual(catalogueFallbacks(BARE), {});
});

test('an EV-only catalogue still offers its EV diagnostic', () => {
  const evOnly = [{ id: 44, name: 'Full EV Diagnostic Assessment', type: 'FIXED', price_numeric: 209 }];
  assert.equal(catalogueFallbacks(evOnly).diagnostic?.id, 44);
});

// ── The directive handed to the model with the catalogue ──
//
// EAC's agent told a customer "we can't book a DPF cleaning over chat… yes, we do offer DPF
// cleaning, but it's best to call us" — and gave the phone number in 56 of 107 conversations.
// The instruction has to arrive with the catalogue, where the decision is made.

test('the directive names the fallbacks with their ids', () => {
  const d = matchingDirective(EAC, true);
  assert.match(d, /"Engine Issue" \(id 25\)/);
  assert.match(d, /"Diagnostic Assessment" \(id 5\)/);
  assert.match(d, /"Others" \(id 141\)/);
});

test('the directive forbids refusing a job the garage can take', () => {
  assert.match(matchingDirective(EAC, true), /do not tell them we cannot book it/i);
});

// The phone number stays available for work the garage genuinely does not do — a motorcycle, a
// towbar it cannot source — but only after the catalogue's own headings have been ruled out.
test('the phone number comes last, not first', () => {
  const d = matchingDirective(EAC, false);
  const dont = d.indexOf('do not give out the phone number');
  const lastResort = d.indexOf('Only if none of those fit');
  const offer = d.lastIndexOf('garage phone number');
  assert.ok(dont > -1 && lastResort > dont, 'the rule must come before the last resort');
  assert.ok(offer > lastResort, 'the phone number must only appear as the last resort');
});

test('with no fallback and no handoff, the phone number is the honest answer', () => {
  assert.match(matchingDirective(BARE, false), /phone number/i);
});

test('with no fallback but handoff on, it takes a message instead', () => {
  const d = matchingDirective(BARE, true);
  assert.match(d, /bk_take_message/);
  assert.doesNotMatch(d, /phone number/i);
});

test('the customer\'s own words go in the notes', () => {
  assert.match(matchingDirective(EAC, true), /their own words/i);
});
