import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mintSlug, demoLinkSchema, SLUG_RE } from './demo-prospect.js';

// The /tyresoft page creates a demo row the moment a garage is picked, so the slug is minted by
// the server now, not only by the seed script. Same shape: their own name leads the URL (the link
// is the pitch), followed by 64 bits of CSPRNG, because a first visit builds the agent and a
// guessable URL would let anyone spend our scrape and OpenAI budget.

test('a minted slug is the garage name plus the random suffix, in the accepted shape', () => {
  const slug = mintSlug('Acme Tyre & Auto Centre', '3f9a2c7e4b1d8056');
  assert.equal(slug, 'acme-tyre-and-auto-centre-3f9a2c7e4b1d8056');
  assert.ok(SLUG_RE.test(slug));
});

test('a long garage name is cut so the slug stays inside the 80-character bound', () => {
  const slug = mintSlug('The Very Long Established Independent Tyre and Exhaust Service Centre of Greater Wolverhampton Limited', '3f9a2c7e4b1d8056');
  assert.ok(slug.length <= 80, `${slug.length} chars`);
  assert.ok(SLUG_RE.test(slug), 'no trailing or doubled hyphens after the cut');
  assert.ok(slug.endsWith('-3f9a2c7e4b1d8056'));
});

test('a name with nothing usable in it still yields a valid slug', () => {
  assert.equal(mintSlug('!!!', 'abcdef0123456789'), 'garage-abcdef0123456789');
  assert.equal(mintSlug('', 'abcdef0123456789'), 'garage-abcdef0123456789');
});

test('the create body needs a garage name; everything else is optional', () => {
  assert.ok(demoLinkSchema.safeParse({ businessName: 'Acme Tyres' }).success);
  assert.ok(demoLinkSchema.safeParse({ businessName: 'Acme Tyres', googlePlaceId: 'ChIJ123', address: 'Telford', prospectId: 'b5b4c0a2-1111-4222-8333-444455556666', source: 'tyresoft-eshot' }).success);
  assert.equal(demoLinkSchema.safeParse({ businessName: 'A' }).success, false, 'one letter is not a garage');
  assert.equal(demoLinkSchema.safeParse({}).success, false);
});
