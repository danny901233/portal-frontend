import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ONBOARDING_EMAIL_NOTES,
  isOnboardingEmail,
  buildOnboardingNote,
  hasCrmSubject,
} from './onboardingCrmNote.js';

// ── A HighLevel timeline note each time an onboarding email goes out ─────────
//
// Onboarding is the one stretch where HighLevel is the system of record: it owns the funnel
// until the opportunity reaches "Live". The portal already mirrors the STAGE across, but not
// what was actually said to the garage, so "have they been sent the setup steps yet?" is a
// question nobody can answer from HL — which is where sales look.
//
// Scoped to onboarding ON PURPOSE, and this is the part that matters most. The portal is the
// CRM once a garage is live: it holds the calls, the bookings, the billing and the tickets, and
// HighLevel cannot hold any of it. Noting every email at the chokepoint would push call
// summaries, arrears warnings and ticket replies into the HL timeline — hundreds a day — and
// bury the handful that describe the onboarding. So the allow-list is the feature, not an
// optimisation: anything not named here is silently ignored.

test('an onboarding email is recognised', () => {
  for (const template of Object.keys(ONBOARDING_EMAIL_NOTES)) {
    assert.ok(isOnboardingEmail(template), `${template} should be an onboarding email`);
  }
});

test('an operational email is not noted', () => {
  // The ones that would flood the timeline. A live garage generates these constantly.
  for (const template of [
    'call-summary',
    'chat-summary',
    'arrears-warning',
    'ticket-reply',
    'unknown',
    '',
  ]) {
    assert.ok(!isOnboardingEmail(template), `${template} must NOT reach HighLevel`);
  }
});

test('an untagged email is never noted', () => {
  // Most EmailLog rows read "unknown" because the sender did not tag itself. An untagged email
  // must be ignored rather than guessed at — a wrong note is worse than no note.
  assert.ok(!isOnboardingEmail(undefined));
  assert.ok(!isOnboardingEmail(null));
});

test('the note says what happened, in words a salesperson can read', () => {
  const note = buildOnboardingNote({
    template: 'gh-getting-ready',
    subject: 'Getting IC Garage LTD ready for ReceptionMate',
    to: ['accounts@icgarage.net'],
  });
  assert.ok(note);
  assert.match(note, /setup steps/i, 'the note does not say what the email was');
  assert.match(note, /accounts@icgarage\.net/, 'the note does not say who it went to');
  assert.match(note, /Getting IC Garage LTD ready/, 'the note does not carry the subject');
});

test('a note is not built for an email we do not track', () => {
  assert.equal(
    buildOnboardingNote({ template: 'call-summary', subject: 'Your call', to: ['a@b.com'] }),
    null,
  );
});

test('every recipient is named, not just the first', () => {
  const note = buildOnboardingNote({
    template: 'agreement-signed',
    subject: 'Signed: ReceptionMate service agreement',
    to: ['accounts@icgarage.net', 'hello@receptionmate.co.uk'],
  });
  assert.ok(note?.includes('accounts@icgarage.net'));
  assert.ok(note?.includes('hello@receptionmate.co.uk'));
});

test('a missing subject does not produce a ragged note', () => {
  const note = buildOnboardingNote({ template: 'agreement-sent', subject: '', to: ['a@b.com'] });
  assert.ok(note && !note.includes('""'), 'an empty subject left empty quotes in the note');
  assert.ok(note && !/\n\n\n/.test(note), 'an empty subject left a gap in the note');
});

test('the tracked set is the onboarding sequence and nothing else', () => {
  // Pinned so a future email cannot be added to the allow-list without a deliberate decision —
  // the whole value of this is that an HL timeline stays readable.
  // Every key here has a sender that tags itself with it. A key with no sender would be a
  // no-op that reads as implemented, so the two are added together or not at all.
  assert.deepEqual(Object.keys(ONBOARDING_EMAIL_NOTES).sort(), [
    'agreement-sent',
    'agreement-signed',
    'gh-connect-request',
    'gh-getting-ready',
  ]);
});

test('an email with neither a garage nor a business is not noted', () => {
  // The agreement emails are BUSINESS level, not garage level — there is no single garage they
  // belong to for a group. Both routes have to be accepted, and neither being present means
  // there is nobody to attach a note to.
  assert.equal(hasCrmSubject({}), false);
  assert.equal(hasCrmSubject({ garageId: null, businessId: null }), false);
  assert.equal(hasCrmSubject({ garageId: 'g1' }), true);
  assert.equal(hasCrmSubject({ businessId: 'b1' }), true);
});
