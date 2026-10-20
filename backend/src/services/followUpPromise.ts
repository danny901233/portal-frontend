/**
 * Did the agent just promise the customer that a person will get back to them?
 *
 * `take_message` is the only thing in the chat agents that flags a conversation and alerts the
 * garage, and the model reliably *says* the right thing without calling it. The existing safety
 * net only catches that in `message_only` with a phone number in hand, so a lead that asks to be
 * EMAILED rather than called is never recorded: Ecotest, 19 Oct 2026, where the agent twice said
 * a Service Advisor would email a clutch enquiry and nobody at the garage was told.
 *
 * So the gate becomes "the agent promised follow-up", read off the agent's own reply, instead of
 * which step the session happens to be on.
 *
 * Deliberately narrow in one direction: an OFFER ("would you like a callback?", "I can arrange
 * for someone to ring you") is not a promise. The customer has not accepted yet, and flagging
 * every offer would put a needs-attention alert on nearly every conversation — noise that would
 * get the alerts ignored, which is the thing being fixed.
 *
 * It wants an explicit commitment that somebody will make contact, not merely a mention of the
 * team: "the team will go through everything with you before any work goes ahead" is reassurance
 * about a booking that already exists; "the team will get back to you" is a debt.
 *
 * Replaces chatAgentV2's `promisesHumanFollowUp`, which this is a superset of — and which every
 * other chat agent lacked entirely. That one was written for Andrew Stolagiewicz, who asked JDK
 * what a B service would cost on 5 Oct 2026 and was told three times that the team would be in
 * touch while nothing was recorded. It listed every way of ringing somebody and not one way of
 * writing to them, which is how Ecotest's clutch enquiry was lost two weeks later.
 */

// Who, other than the agent, is going to make contact.
const PERSON = '(?:the team|our team|the garage|the workshop|a service advisor|an advisor|'
  + 'an adviser|my colleague|a colleague|a member of the team|someone|somebody|they|we)';

// The booking confirmation the system sends itself. "We'll email you a confirmation" is a promise
// already kept, and flagging it would put every booked chat in the needs-attention list.
const CONFIRMATION = /\bconfirmation\b|\bconfirming your (?:booking|appointment)\b/i;
// How they are going to make it. "email" is here because its absence is the whole bug: the
// predicate this replaces listed every way of ringing somebody and not one way of writing to them.
const CONTACT = '(?:e-?mail|call|ring|phone|text|message|contact|be in touch|get back|'
  + 'come back|reach out)';

// "the team will be in touch", "a Service Advisor will email you", "someone will call you back".
const THIRD_PARTY_WILL = new RegExp(
  `\\b${PERSON}\\b[^.!?]{0,40}\\b(?:will|’ll|'ll)\\b[^.!?]{0,40}\\b${CONTACT}\\b`, 'i');

// "I'll get a Service Advisor to email you", "I'll pass that on to the team", "let me have someone
// ring you". Requires a commitment AND a hand-off, so "I'll get that booked in" is untouched.
const I_WILL_HAND_OFF = new RegExp(
  `\\b(?:(?:i|we)\\s*(?:’ll|'ll|\\s+will)|let me)\\b[^.!?]{0,60}`
  + `\\b(?:pass (?:that|this|it|them) on|flag (?:that|this|it) (?:up|to)|let the team know|`
  + `make sure the team|get (?:someone|somebody|a|an|the)[^.!?]{0,30}\\bto\\s+${CONTACT}|`
  + `have (?:someone|somebody)[^.!?]{0,20}\\b${CONTACT}|`
  + `ask (?:the team|someone|somebody)\\b)`, 'i');

// "The team will be in touch" with no subject the patterns above recognise.
const BE_IN_TOUCH = /\b(?:will|’ll|'ll)\s+be\s+in\s+touch\b/i;

/** The agent is promising a person will make contact. */
export function promisesFollowUp(reply: string): boolean {
  const text = String(reply || '');
  if (!text.trim()) return false;

  // Sentence by sentence, so a promise in one sentence is not cancelled by a question in the next
  // — and so a question is never read as a promise.
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    const s = sentence.trim();
    if (!s || s.endsWith('?') || CONFIRMATION.test(s)) continue;
    if (THIRD_PARTY_WILL.test(s) || I_WILL_HAND_OFF.test(s) || BE_IN_TOUCH.test(s)) return true;
  }
  return false;
}

/**
 * The first email address in a message, or null.
 *
 * Used to keep the address a customer types in chat ("my email is …") on the session, so the
 * escalation the garage receives says where to reply. Requires a dot in the domain and at least
 * two trailing letters, and trailing punctuation is left out of the match.
 */
export function firstEmailAddress(text: string): string | null {
  const m = String(text || '').match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  if (!m) return null;
  return m[0].replace(/[.,;:!?)\]]+$/, '');
}

/**
 * Did the agent tell the customer their booking is made?
 *
 * The counterpart to promisesFollowUp, for the worse failure: not an unrecorded promise but an
 * announced booking that does not exist. Speedy Spanners, 19 Oct 2026 — the diary date never got
 * set (see timePreference.ts for why), the agent said "All booked in for 2nd November" anyway,
 * and the customer went away expecting her car to be collected.
 *
 * Only a statement counts. "Would you like me to book that in?" and "I can get you booked in" are
 * the ordinary booking conversation, and flagging those would flag nearly every chat.
 */
const BOOKING_CLAIMED = [
  // "all booked in", "you're booked in for", "that's booked for"
  /\b(?:all\s+)?booked\s+(?:you\s+)?in\b/i,
  /\b(?:you(?:'|’)?re|you\s+are|it(?:'|’)?s|it\s+is|that(?:'|’)?s|that\s+is)\s+(?:now\s+)?booked\b/i,
  /\byour\s+booking\s+is\s+(?:confirmed|in|made)\b/i,
];
// Deliberately absent: "I've got you down for <date>". That is how the agent PROPOSES a drop-off
// slot — "I've got you down for Tuesday 27th October at 8:30am — does that work for you?" — and
// reading it as a claim flagged a booking that was going perfectly well.

// "can", "could", "shall", "would like" — an offer, not a fact. Checked on the same sentence.
const OFFER = /\b(?:can|could|shall|may|would|happy to|able to|if you(?:'|’)?d like|want me to)\b/i;

export function claimsBookingMade(reply: string): boolean {
  const text = String(reply || '');
  if (!text.trim()) return false;

  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    const s = sentence.trim();
    if (!s || s.endsWith('?') || OFFER.test(s)) continue;
    if (BOOKING_CLAIMED.some((re) => re.test(s))) return true;
  }
  return false;
}
