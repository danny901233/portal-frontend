import { test } from 'node:test';
import assert from 'node:assert/strict';

import { promisesFollowUp, firstEmailAddress, claimsBookingMade } from './followUpPromise.js';

// The Ecotest lead, 19 Oct 2026 (conversation cmvf2ax520cj5swt16ca1buc8). The agent said this and
// nobody at the garage was ever told, because take_message was never called.
test('a promise that an advisor will email is a promise', () => {
  assert.equal(
    promisesFollowUp('I’ll get a Service Advisor to email you at licigrant4@gmail.com and they’ll cover everything you’ve mentioned.'),
    true,
  );
});

// Same conversation, four minutes earlier. This one is a QUESTION — the customer had not said yes
// yet, so flagging here would flag every chat that merely offers a callback.
test('offering a callback and asking if they want one is not a promise', () => {
  assert.equal(
    promisesFollowUp('If you’d like, I can arrange for a Service Advisor to ring you back with all the details. Would you like a callback?'),
    false,
  );
});

test('"the team will be in touch" is a promise', () => {
  assert.equal(promisesFollowUp('Perfect — the team will be in touch shortly to confirm your MOT.'), true);
});

test('"I\'ll pass that on to the team" is a promise', () => {
  assert.equal(promisesFollowUp("Thanks Dave, I'll pass that on to the team."), true);
});

test('someone will call you back is a promise', () => {
  assert.equal(promisesFollowUp('Someone will give you a call back shortly.'), true);
});

// The booking path must not trip this. These are the agent's ordinary replies.
test('getting a booking in is not a promise of follow-up', () => {
  assert.equal(promisesFollowUp("Perfect, I'll get that booked in for you now."), false);
});

test('checking a price is not a promise of follow-up', () => {
  assert.equal(promisesFollowUp("No problem, I'll check that price for you."), false);
});

test('asking whether someone should call is not a promise', () => {
  assert.equal(promisesFollowUp('Would you like someone to call you back about it?'), false);
});

test('a confirmed booking is not a follow-up promise', () => {
  assert.equal(
    promisesFollowUp("You're booked in for Tuesday at 9am — see you then!"),
    false,
  );
});

test('an empty reply is not a promise', () => {
  assert.equal(promisesFollowUp(''), false);
});

// Everything the predicate this replaces (chatAgentV2's promisesHumanFollowUp) already caught.
// Missing any of these would quietly un-fix the leads its safety net does catch today.
test('reaching out is a promise', () => {
  assert.equal(promisesFollowUp("We'll reach out to you shortly."), true);
});

test('getting back to you is a promise', () => {
  assert.equal(promisesFollowUp("They'll get back to you later today."), true);
});

test('a named colleague giving you a ring is a promise', () => {
  assert.equal(promisesFollowUp('My colleague will give you a ring this afternoon.'), true);
});

test('asking the team is a promise', () => {
  assert.equal(promisesFollowUp("I'll ask the team and come back to you."), true);
});

test('"let me pass this on" is a promise', () => {
  assert.equal(promisesFollowUp('Let me pass this on to the team for you.'), true);
});

// "we" is the garage, so it promises on the garage's behalf — but a booking confirmation is the
// system's own email, already sent, and flagging those would put every booked chat in the
// needs-attention list.
test('a confirmation email after a booking is not a promise of follow-up', () => {
  assert.equal(
    promisesFollowUp("You're booked in for Tuesday at 9am — we'll email you a confirmation shortly."),
    false,
  );
});

test('the garage being in touch about something else is a promise', () => {
  assert.equal(promisesFollowUp("We'll be in touch about the parts once they land."), true);
});

test('letting the team know is a promise', () => {
  assert.equal(promisesFollowUp('I’ll let the team know.'), true);
});

// The address the customer typed was never stored, so even once the garage was told, the one thing
// they needed — where to email her — was only in the transcript.
test('an email address is picked out of what the customer typed', () => {
  assert.equal(
    firstEmailAddress('I would also like to know standard cost. My email is licigrant4@gmail.com'),
    'licigrant4@gmail.com',
  );
});

test('a trailing full stop is not part of the address', () => {
  assert.equal(firstEmailAddress('email me at bob.smith@foo.co.uk.'), 'bob.smith@foo.co.uk');
});

test('no address returns null', () => {
  assert.equal(firstEmailAddress('can you email me the prices please'), null);
});

test('a bare domain is not an address', () => {
  assert.equal(firstEmailAddress('have a look at bracknellmot-ecotest.co.uk'), null);
});

// ── A booking the agent announced ──
//
// Speedy Spanners, 19 Oct 2026: three rounds of "which date suits you?" and then "All booked in
// for 2nd November" — with no date on the session and nothing ever sent to the diary. Laura was
// expecting a collection that nobody at the garage knew about.

test('"all booked in" is a claim', () => {
  assert.equal(
    claimsBookingMade('All booked in for 2nd November — we’ll collect your Tucson in the morning.'),
    true,
  );
});

test('"you\'re booked in for" is a claim', () => {
  assert.equal(claimsBookingMade("All done! You're booked in for Friday 11th December at 8:30am."), true);
});

test('"that is now booked" is a claim', () => {
  assert.equal(claimsBookingMade('That’s now booked for Tuesday, see you then!'), true);
});

// "I've got you down for Tuesday 27th October at 8:30am — does that work for you?" is how the
// agent PROPOSES a drop-off slot. Caught as a false positive on the GH test garage: the question
// mark governs the whole reply, so the clause before the dash is not a claim.
test('proposing a slot and asking if it works is not a claim', () => {
  assert.equal(
    claimsBookingMade("I've got you down for Tuesday 27th October at 8:30am — does that work for you?"),
    false,
  );
});

test('a dash does not detach the question mark that follows it', () => {
  assert.equal(claimsBookingMade('Booked you in for Monday — is that still alright?'), false);
});

// Offers and questions are the normal booking conversation and must not trip it.
test('offering to book is not a claim', () => {
  assert.equal(claimsBookingMade('Would you like me to book that in for you?'), false);
});

test('saying it can be booked is not a claim', () => {
  assert.equal(claimsBookingMade('I can get you booked in for Friday if that suits.'), false);
});

test('asking which date suits is not a claim', () => {
  assert.equal(claimsBookingMade('Is 2nd November still good for you, or would you like another date?'), false);
});

test('a price with no booking is not a claim', () => {
  assert.equal(claimsBookingMade('A Full Service for your Ford Kuga is £289.20.'), false);
});

test('an empty reply is not a claim', () => {
  assert.equal(claimsBookingMade(''), false);
});
