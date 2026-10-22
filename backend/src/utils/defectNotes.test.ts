/**
 * Working the fault list: a note per fault, an "actioned" flag, and a filter.
 *
 * Dan, 22 Oct 2026: "next to each call we can add 'diagnosis note' this way we can add notes,
 * or attach it to claudes to add notes. Also a Actioned button to show calls that we've fixed.
 * maybe we can filter the flagged calls for outstanding, and completed?"
 *
 * Notes live in their own table, keyed on (callId, signature), because the scanner rewrites a
 * call's findings on every rescan.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mergeDefectNotes } from './defectNotes.js';

const findings = [
  { id: 'f1', callId: '111', signature: 'silent-call', severity: 'high', detail: 'heard nothing' },
  { id: 'f2', callId: '111', signature: 'ai:misheard', severity: 'medium', detail: 'name wrong' },
  { id: 'f3', callId: '222', signature: 'agent-repeating', severity: 'medium', detail: 'asked twice' },
];

test('a fault with no note is outstanding', () => {
  const out = mergeDefectNotes(findings, [], 'all');
  assert.equal(out.length, 3);
  assert.equal(out[0].note, null);
  assert.equal(out[0].actionedAt, null);
  assert.equal(out[0].actioned, false);
});

test('a note attaches to the fault it was written against', () => {
  const out = mergeDefectNotes(findings, [
    { callId: '111', signature: 'ai:misheard', note: 'ASR; raised with Deepgram', actionedAt: null, actionedBy: null },
  ], 'all');
  const mine = out.find((f) => f.id === 'f2');
  assert.equal(mine?.note, 'ASR; raised with Deepgram');
  // The same call's OTHER fault must stay untouched — a note keyed only on the
  // call id would smear across every fault on it.
  assert.equal(out.find((f) => f.id === 'f1')?.note, null);
});

test('a note on another call does not leak', () => {
  const out = mergeDefectNotes(findings, [
    { callId: '222', signature: 'agent-repeating', note: 'fixed in 0b54782', actionedAt: null, actionedBy: null },
  ], 'all');
  assert.equal(out.find((f) => f.id === 'f3')?.note, 'fixed in 0b54782');
  assert.equal(out.find((f) => f.id === 'f1')?.note, null);
});

test('an actioned fault reports who and when', () => {
  const when = new Date('2026-10-22T12:00:00.000Z');
  const out = mergeDefectNotes(findings, [
    { callId: '111', signature: 'silent-call', note: 'ElevenLabs quota', actionedAt: when, actionedBy: 'dan@receptionmate.co.uk' },
  ], 'all');
  const f = out.find((x) => x.id === 'f1');
  assert.equal(f?.actioned, true);
  assert.deepEqual(f?.actionedAt, when);
  assert.equal(f?.actionedBy, 'dan@receptionmate.co.uk');
});

// ── the filter ───────────────────────────────────────────────────────────

test('outstanding hides the ones already dealt with', () => {
  const out = mergeDefectNotes(findings, [
    { callId: '111', signature: 'silent-call', note: null, actionedAt: new Date(), actionedBy: 'dan' },
  ], 'outstanding');
  assert.deepEqual(out.map((f) => f.id), ['f2', 'f3']);
});

test('completed shows only the ones dealt with', () => {
  const out = mergeDefectNotes(findings, [
    { callId: '111', signature: 'silent-call', note: null, actionedAt: new Date(), actionedBy: 'dan' },
  ], 'completed');
  assert.deepEqual(out.map((f) => f.id), ['f1']);
});

test('a note alone does not count as completed', () => {
  // Writing down what you found is not the same as fixing it.
  const out = mergeDefectNotes(findings, [
    { callId: '111', signature: 'silent-call', note: 'still looking at this', actionedAt: null, actionedBy: null },
  ], 'outstanding');
  assert.ok(out.some((f) => f.id === 'f1'), 'a noted but unfixed fault is still outstanding');
});

test('an unknown filter shows everything rather than nothing', () => {
  // A typo in a query parameter must not look like a clean board.
  assert.equal(mergeDefectNotes(findings, [], 'nonsense' as never).length, 3);
  assert.equal(mergeDefectNotes(findings, [], undefined).length, 3);
});

test('junk input yields an empty list, not a crash', () => {
  assert.deepEqual(mergeDefectNotes(undefined as never, [], 'all'), []);
  assert.equal(mergeDefectNotes(findings, undefined as never, 'all').length, 3);
});
