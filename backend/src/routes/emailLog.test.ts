import { test } from 'node:test';
import assert from 'node:assert/strict';

import { recipientPattern, emailLogWhere } from './emailLog.js';

// The log existed for a year answering "did we email them?" with an empty table, because the
// recipient filter was an exact whole-address match on a text[] and the box invited you to type
// a name. Searching "mareks" for mareks.kirilovics@garagehive.com returned nothing, and nothing
// in the UI said why. These tests pin the two halves of the fix: the search is a substring, and
// the substring is still only ever a parameter.

// ── recipientPattern ───────────────────────────────────────────────────────

test('a fragment of an address becomes a contains pattern', () => {
  assert.equal(recipientPattern('mareks'), '%mareks%');
  assert.equal(recipientPattern('@garagehive.com'), '%@garagehive.com%');
});

test('a full address still matches, so the old habit keeps working', () => {
  assert.equal(
    recipientPattern('mareks.kirilovics@garagehive.com'),
    '%mareks.kirilovics@garagehive.com%',
  );
});

test('surrounding whitespace from a paste is dropped', () => {
  assert.equal(recipientPattern('  admin@cartopia.uk \n'), '%admin@cartopia.uk%');
});

// A caller typing a wildcard must not get wildcard behaviour: "%" alone would otherwise match
// every address the portal has ever mailed, which reads as "we emailed everyone" on a page whose
// whole purpose is answering that question precisely.
test('LIKE wildcards in the search term are escaped, not honoured', () => {
  assert.equal(recipientPattern('%'), '%\\%%');
  assert.equal(recipientPattern('a_b'), '%a\\_b%');
  assert.equal(recipientPattern('back\\slash'), '%back\\\\slash%');
});

// ── emailLogWhere ──────────────────────────────────────────────────────────

test('no filters matches every row rather than none', () => {
  const where = emailLogWhere({});
  assert.equal(where.text.trim(), 'TRUE');
  assert.deepEqual(where.values, []);
});

test('the recipient search is a parameter, never interpolated SQL', () => {
  const where = emailLogWhere({ to: "o'brien@example.com'; drop table \"EmailLog\"; --" });
  assert.ok(!where.text.includes('drop table'), 'the term leaked into the SQL text');
  assert.deepEqual(where.values, ["%o'brien@example.com'; drop table \"EmailLog\"; --%"]);
  assert.ok(where.text.includes('ILIKE'), 'expected a case-insensitive contains match');
});

// cc matters as much as to: the GarageHive connect request goes TO GarageHive and ccs us, so a
// search for our own address has to find it or the audit trail has a hole exactly where someone
// is asking "what did we send them?".
test('cc is searched alongside to', () => {
  const where = emailLogWhere({ to: 'hello@receptionmate.co.uk' });
  assert.ok(where.text.includes('"to"'), 'to column missing from the search');
  assert.ok(where.text.includes('cc'), 'cc column missing from the search');
});

test('the other filters are exact matches and stack with AND', () => {
  const where = emailLogWhere({
    to: 'mareks',
    template: 'diary_connect_request_garagehive',
    status: 'delivered',
    garageId: '6701ba7d-85ad-4515-b34c-e3e1b8069767',
  });
  assert.equal(
    where.values.length,
    4,
    'every filter should contribute exactly one bound parameter',
  );
  assert.ok(where.text.includes(' AND '), 'filters should be ANDed together');
  assert.ok(where.values.includes('delivered'));
  assert.ok(where.values.includes('6701ba7d-85ad-4515-b34c-e3e1b8069767'));
  // The substring is the only fuzzy axis — a template or status typo should return nothing
  // rather than quietly matching neighbours.
  assert.ok(where.text.includes('template = '));
  assert.ok(where.text.includes('status = '));
});

test('an empty filter value is ignored rather than matching the empty string', () => {
  const where = emailLogWhere({ to: '', template: '', status: '', garageId: '' });
  assert.equal(where.text.trim(), 'TRUE');
  assert.deepEqual(where.values, []);
});
