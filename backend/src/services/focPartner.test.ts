import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DID, FROM, mergeTags } from './highlevelTags.js';
import { HL_FOC_STAGE_NAME } from './highlevel.js';

// A free-of-charge partner is live on the product and pays nothing. The two things that must stay
// true: it is never counted as revenue, and it is never mistaken for a trial that will convert.

test('the FOC stage has a name to resolve by, since the token cannot create one', () => {
  // The PIT has no pipeline-write scope (401), so the stage is made by hand in HighLevel and
  // found by name. An empty name would silently resolve to nothing on every call.
  assert.ok(HL_FOC_STAGE_NAME.trim().length > 0);
});

test('an FOC partner is tagged as live-for-free, not as a trial', () => {
  const tags = mergeTags([FROM.website], [DID.focLive]);
  assert.ok(tags.includes(DID.focLive));
  assert.ok(!tags.includes(DID.trial), 'a barter deal is not a trial — nothing converts on a date');
});

test('did-live-foc is its own tag, not an alias of anything else', () => {
  const all = Object.values(DID);
  assert.equal(all.filter((t) => t === DID.focLive).length, 1);
  assert.equal(DID.focLive, 'did-live-foc');
});
