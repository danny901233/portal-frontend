/**
 * What we are allowed to store as "the caller's number".
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Advanced Service Centre thumbed down call 45674754 with "this is our own
 * internal number i dont know how whats happened". They were right: the call
 * came in with caller ID withheld, the agent warm-transferred it, and the
 * number the agent dialled (their own transfer line, +441375803104) was written
 * back as the customer's. Ringing it reaches the garage itself. Ten of their
 * calls since 23 Sep were recorded that way, and three more stored the literal
 * string "anonymous" in a phone column.
 *
 * The agent-side cause is fixed separately, but every one of the eight voice
 * agents posts here, so this is the one place that can hold the line for all of
 * them at once. Two rules, both of which answer "could a human ring this back
 * and reach the person who called?":
 *
 *   1. A withheld caller has no number. Store null, not a carrier's stand-in
 *      word — a phone column is for phone numbers.
 *   2. The garage's own lines are not the caller. If the stored number is the
 *      line they publish or the line the agent transfers to, we learned nothing
 *      about who rang, and saying otherwise sends staff chasing themselves.
 *
 * Rule 2 does suppress the genuine case of someone ringing in from the garage's
 * own landline, which is nearly always staff testing the agent. That trade is
 * deliberate: the agent already drops a forwarded call presenting the
 * forwarding number for the same reason, and a blank is honest where the
 * garage's own number is actively misleading.
 */

import { isWithheldCaller, normaliseCaller } from './callerBlocklist.js';

/**
 * Enough trailing digits to identify a line without demanding both sides agree on
 * the dialling prefix: +441375803104 and 01375803104 share "375803104".
 */
const MATCH_DIGITS = 9;

const tail = (raw: string | null | undefined): string => {
  const digits = normaliseCaller(raw);
  // Anything shorter than a full subscriber number would match far too much — an
  // extension or a junk config value must not swallow unrelated callers.
  return digits.length >= MATCH_DIGITS ? digits.slice(-MATCH_DIGITS) : '';
};

/** Is this one of the garage's own lines rather than a caller's? */
export function isOwnGarageNumber(
  candidate: string | null | undefined,
  ownNumbers: Array<string | null | undefined>,
): boolean {
  const want = tail(candidate);
  if (!want) return false;
  return ownNumbers.some((own) => tail(own) === want);
}

/**
 * The value to store for a caller's number, or null when we never learned it.
 *
 * `ownNumbers` are the garage's own lines — its published number, the number the
 * agent transfers to, the screening number. An empty list disables rule 2 rather
 * than failing closed, so a garage with nothing configured still gets real
 * numbers stored.
 */
export function callerNumberForStorage(
  raw: string | null | undefined,
  ownNumbers: Array<string | null | undefined> = [],
): string | null {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;
  if (isWithheldCaller(trimmed)) return null;
  if (isOwnGarageNumber(trimmed, ownNumbers)) return null;
  return trimmed;
}
