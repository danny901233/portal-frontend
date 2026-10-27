import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tagsForSource, isBlendSource } from './public-prospect.js';
import { DID, FROM } from '../services/highlevelTags.js';

// The campaign tag is decided at the garage-search step, because that is the only moment every
// QR scan passes through: most never reach the offer, and those are exactly the ones worth
// knowing came from the stand.
//
// The half that matters is the INVERSE. A Blend tag on an ordinary website lead would quietly
// overstate what the show produced, and nothing downstream would ever contradict it. So the
// list below is every `source` value that actually exists in the production table — if a new
// funnel is added with a name beginning "blend-", this test is where that gets noticed.

const PRODUCTION_SOURCES_NOT_BLEND = [
  'website-getstarted',
  'website-getstarted-automate-garagehive',
  'website-mot-campaign',
  'website-hero-talk-to-leah',
  'website-integrations-contact',
];

// The from-/did- vocabulary is written alongside the legacy tags now (see services/
// highlevelTags.ts), so these assert the campaign rule rather than the exact list. The legacy
// pair leading every list is still checked, because HL smart lists filter on it.
const LEGACY_BASE = ['website-signup', 'abandoned-checkout'];

test('a Blend QR scan is tagged for the campaign', () => {
  const tags = tagsForSource('blend-show');
  assert.deepEqual(tags.slice(0, 3), [...LEGACY_BASE, 'blend-2026']);
  assert.ok(tags.includes(FROM.tradeShow), 'a show prospect should carry the show origin');
  assert.ok(!tags.includes(FROM.website), 'a show prospect is not a website prospect');
});

test('every other funnel in production carries no campaign tag', () => {
  for (const source of PRODUCTION_SOURCES_NOT_BLEND) {
    const tags = tagsForSource(source);
    assert.deepEqual(tags.slice(0, 2), LEGACY_BASE, source);
    assert.ok(!tags.includes('blend-2026'), `${source} picked up a campaign tag it should not have`);
    assert.ok(!tags.includes(FROM.tradeShow), `${source} picked up the show origin it should not have`);
    assert.ok(tags.includes(FROM.website), `${source} should say it came from the website`);
  }
});

test('a prospect with no source is not attributed to the show', () => {
  // 31 rows in production predate the source column entirely.
  for (const source of [null, undefined, '']) {
    const tags = tagsForSource(source);
    assert.deepEqual(tags.slice(0, 2), LEGACY_BASE);
    assert.ok(!tags.includes('blend-2026'));
    assert.ok(!tags.includes(FROM.tradeShow));
  }
});

// What the pipeline could not show before: picking a garage out of the Places search is the
// start of a signup, and that is now on the record separately from having abandoned it.
test('the garage-search step records that a signup was started', () => {
  const tags = tagsForSource('website-getstarted');
  assert.ok(tags.includes(DID.signupStarted));
  assert.ok(tags.includes(DID.abandonedCheckout));
});

test('the match is on the prefix of a source we set, not on the word appearing anywhere', () => {
  // "blend" inside a name must not be enough — only a source this codebase posts.
  assert.equal(isBlendSource('website-blend-lookalike'), false);
  assert.equal(isBlendSource('my-blend-show'), false);
  assert.equal(isBlendSource('blend-show'), true);
  assert.equal(isBlendSource('blend-show-unsupported-gms'), true);
});

test('the base tags are never dropped, only added to', () => {
  for (const s of ['blend-show', 'website-getstarted', null]) {
    const t = tagsForSource(s);
    assert.ok(t.includes('website-signup') && t.includes('abandoned-checkout'), String(s));
  }
});
