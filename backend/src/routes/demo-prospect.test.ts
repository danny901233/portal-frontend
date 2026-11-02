import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mintSlug, demoLinkSchema, rowFromListing, SLUG_RE } from './demo-prospect.js';
import type { WeeklyOpeningHours } from '../utils/googlePlaces.js';

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

// The agent greets callers with the garage's name and may speak its address, so neither may come
// from the visitor: a self-serve demo needs a Google listing, and the name, address, phone and
// hours are taken from that listing on the server. A manual entry gets no personal demo.
test('the create body needs a Google place id; a name on its own is not enough', () => {
  assert.ok(demoLinkSchema.safeParse({ googlePlaceId: 'ChIJ123' }).success);
  assert.ok(demoLinkSchema.safeParse({ googlePlaceId: 'ChIJ123', prospectId: 'b5b4c0a2-1111-4222-8333-444455556666', source: 'tyresoft-eshot' }).success);
  assert.equal(demoLinkSchema.safeParse({ businessName: 'Acme Tyres' }).success, false, 'no listing, no demo');
  assert.equal(demoLinkSchema.safeParse({}).success, false);
});

test('a listing with no name cannot become a demo', () => {
  assert.equal(rowFromListing('ChIJ123', null), null);
  assert.equal(rowFromListing('ChIJ123', { address: '1 High St' }), null);
});

test('the row is built from the listing, with hours only when Google gives an open week', () => {
  const open = { monday: { open: '08:00', close: '17:30', closed: false }, tuesday: { open: null, close: null, closed: true }, wednesday: { open: null, close: null, closed: true }, thursday: { open: null, close: null, closed: true }, friday: { open: null, close: null, closed: true }, saturday: { open: null, close: null, closed: true }, sunday: { open: null, close: null, closed: true } };
  const row = rowFromListing('ChIJ123', { name: 'ACME TYRE & AUTO CENTRE', address: '1 High St, Telford', phone: '01952 000000', website: 'https://acmetyres.co.uk/', weeklyOpeningHours: open });
  assert.ok(row);
  assert.equal(row.placeId, 'ChIJ123');
  assert.equal(row.businessName, 'ACME TYRE & AUTO CENTRE');
  assert.equal(row.branchAddress, '1 High St, Telford');
  assert.equal(row.phoneNumber, '01952 000000');
  assert.equal(row.websiteUrl, 'acmetyres.co.uk', 'stored scheme-less, as the seeder stores it');
  assert.deepEqual(row.weeklyOpeningHours, open);
  assert.equal(row.hoursSource, 'google');
  assert.ok(row.spokenName.length > 0);

  const allClosed = Object.fromEntries(Object.keys(open).map((d) => [d, { open: null, close: null, closed: true }])) as unknown as WeeklyOpeningHours;
  const shut = rowFromListing('ChIJ123', { name: 'Acme', weeklyOpeningHours: allClosed });
  assert.ok(shut);
  assert.equal(shut.weeklyOpeningHours, null, 'an all-closed week must not be stored, or the demo tells callers they are shut');
  assert.equal(shut.hoursSource, null);
});
