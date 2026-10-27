import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DID, FROM, mergeTags, websiteOriginTags } from './highlevelTags.js';
import { tagsForSource } from '../routes/public-prospect.js';

// The point of the vocabulary is that a tag list answers "where did this come from" and "how far
// did they get" without anyone opening the record. Both halves have to be present, and the legacy
// tags have to survive, because HL smart lists and workflows filter on them.

test('an ordinary funnel touch is tagged website, not trade show', () => {
  assert.deepEqual(websiteOriginTags({ source: 'website-getstarted' }), [FROM.website]);
  assert.deepEqual(websiteOriginTags({ source: 'website-hero-talk-to-leah' }), [FROM.website]);
  assert.deepEqual(websiteOriginTags({}), [FROM.website]);
});

test('a show funnel is tagged for the stand', () => {
  assert.deepEqual(websiteOriginTags({ source: 'blend-show' }), [FROM.tradeShow]);
  assert.deepEqual(websiteOriginTags({ source: 'blend-show-integration-wanted' }), [FROM.tradeShow]);
});

// A show lead that arrived through an ad is both. Replacing one origin with the other would make
// the stand look like it produced a lead the ad paid for, or the reverse.
test('an ad click adds an origin rather than replacing one', () => {
  assert.deepEqual(websiteOriginTags({ source: 'blend-show', fromAds: true }), [FROM.tradeShow, FROM.googleAds]);
  assert.deepEqual(websiteOriginTags({ source: 'website-getstarted', fromAds: true }), [FROM.website, FROM.googleAds]);
});

test('mergeTags keeps the first of each and drops blanks', () => {
  assert.deepEqual(
    mergeTags(['website-lead', ' '], [FROM.website, 'website-lead'], undefined, [DID.enquiry]),
    ['website-lead', FROM.website, DID.enquiry],
  );
});

// The garage-search step is the one every signup passes through, so the tags it writes are the
// ones most often read. The legacy pair must still be first and unchanged.
test('the Places garage-search step keeps its legacy tags and gains the new ones', () => {
  assert.deepEqual(tagsForSource('website-getstarted'), [
    'website-signup',
    'abandoned-checkout',
    FROM.website,
    DID.signupStarted,
    DID.abandonedCheckout,
  ]);
  assert.deepEqual(tagsForSource('blend-show'), [
    'website-signup',
    'abandoned-checkout',
    'blend-2026',
    FROM.tradeShow,
    DID.signupStarted,
    DID.abandonedCheckout,
  ]);
});

// Every did-* value has to be distinct from every from-* value: one list of tags carries both,
// and a collision would make a touch unfilterable.
test('the two prefixes never collide', () => {
  const all = [...Object.values(FROM), ...Object.values(DID)];
  assert.equal(new Set(all).size, all.length);
  for (const t of Object.values(FROM)) assert.ok(t.startsWith('from-'), t);
  for (const t of Object.values(DID)) assert.ok(t.startsWith('did-'), t);
});
