import { test } from 'node:test';
import assert from 'node:assert/strict';

import { refuseImport } from './tyresoftCustomerIngest.js';

/**
 * The ingest DELETES every row for the garage and re-inserts from the file. That is correct
 * only if every file really is a full snapshot, and nobody has confirmed that with Tyresoft.
 *
 * Even once they do, the same shape of accident happens anyway: a half-written SFTP upload, a
 * failed export, a truncated transfer. Elite's real file is 29,646 customers. A 200-row file
 * arriving on a Sunday night would leave caller recognition answering NO_MATCH for everyone,
 * and the only clue would be that it quietly stopped working.
 *
 * A stale snapshot is wrong by a day. An empty one is wrong until somebody notices.
 */

const call = (incoming: number, existing: number, force = false, floor = 0.5) =>
  refuseImport({ incoming, existing, floor, force });

test('a normal full snapshot goes through', () => {
  assert.equal(call(29646, 29644), null);
});

test('modest churn in either direction is fine', () => {
  assert.equal(call(28000, 29644), null, 'a 5% shrink is ordinary');
  assert.equal(call(31000, 29644), null, 'growth is always fine');
});

test('the first run has nothing to lose, so anything is accepted', () => {
  assert.equal(call(1, 0), null);
  assert.equal(call(0, 0), null);
});

test('a delta file is refused — this is the one that would empty the table', () => {
  // The real scenario: Tyresoft sends changed rows only, nobody told us, and the job
  // interprets it as "everyone else has been deleted".
  const r = call(200, 29644);
  assert.ok(r, 'a 200-row file against 29,644 stored must be refused');
  assert.match(r!, /200 customers against 29644/);
  assert.match(r!, /TYRESOFT_INGEST_FORCE=1/, 'the message must say how to override it');
});

test('an empty file is refused even with FORCE — an empty snapshot is never real', () => {
  assert.match(call(0, 29644)!, /empty customer file/);
  assert.match(call(0, 29644, true)!, /empty customer file/,
    'FORCE overrides a suspicious shrink, never an empty file');
});

test('FORCE lets a genuine collapse through', () => {
  // A garage really did lose most of its customers, and a person has decided so.
  assert.equal(call(200, 29644, true), null);
});

test('the floor is configurable and is applied as a fraction', () => {
  assert.equal(call(8000, 10000, false, 0.5), null, '80% is above a 50% floor');
  assert.ok(call(4000, 10000, false, 0.5), '40% is below it');
  assert.ok(call(8000, 10000, false, 0.9), '80% is below a 90% floor');
});

test('exactly at the floor is accepted, not refused', () => {
  assert.equal(call(5000, 10000, false, 0.5), null);
});
