import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tagsForSource, isBlendSource } from './public-prospect.js';

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

test('a Blend QR scan is tagged for the campaign', () => {
  assert.deepEqual(tagsForSource('blend-show'), ['website-signup', 'abandoned-checkout', 'blend-2026']);
});

test('every other funnel in production is tagged exactly as before', () => {
  for (const source of PRODUCTION_SOURCES_NOT_BLEND) {
    assert.deepEqual(
      tagsForSource(source),
      ['website-signup', 'abandoned-checkout'],
      `${source} picked up a campaign tag it should not have`,
    );
  }
});

test('a prospect with no source is not attributed to the show', () => {
  // 31 rows in production predate the source column entirely.
  assert.deepEqual(tagsForSource(null), ['website-signup', 'abandoned-checkout']);
  assert.deepEqual(tagsForSource(undefined), ['website-signup', 'abandoned-checkout']);
  assert.deepEqual(tagsForSource(''), ['website-signup', 'abandoned-checkout']);
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
