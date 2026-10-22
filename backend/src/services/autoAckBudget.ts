/**
 * How many times we are willing to acknowledge the same sender automatically.
 *
 * The acknowledgement is the one email the system sends with nobody's
 * approval, so it is the one email that can run away. On 22 Oct 2026 it did:
 * Torque GT's Zendesk answered our acknowledgement, we answered theirs, and
 * the two robots exchanged fifteen messages in two minutes — a new ticket
 * every time, because their subject replaced ours. It stopped when the sender
 * was blocked by hand.
 *
 * `emailClassifier.ts` now reads the headers Zendesk was already setting, so
 * that particular loop ends at the first message. This is the backstop for the
 * autoresponder that sets no headers at all — which is exactly the shape of
 * the last bug here (an Outdoorsy address the no-reply guard could not read).
 * A rule has to recognise the robot; a budget does not have to know anything.
 *
 * Deliberately a count and not a lock: whoever writes in gets answered, the
 * fourth copy in an hour just does not get answered automatically. A real
 * person emailing four times in an hour is already a conversation, and the
 * ticket is in the queue either way.
 */

/** Acknowledgements to one sender in a rolling hour. A loop reaches this in
 *  under a minute; a person has to be writing in every fifteen minutes. */
export const ACK_MAX_PER_HOUR = 3;

/** And in a rolling day, so an hourly cap cannot add up to 72 overnight. */
export const ACK_MAX_PER_DAY = 5;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Is this sender over budget? Takes the times we have already acknowledged
 * them (the caller fetches the last day's worth) and returns the window that
 * is full, for the log, or null to go ahead.
 */
export function autoAckOverBudget(previousAcks: Date[], now: Date): string | null {
  const since = (ms: number) => previousAcks.filter((d) => now.getTime() - d.getTime() < ms).length;
  if (since(HOUR_MS) >= ACK_MAX_PER_HOUR) return `${ACK_MAX_PER_HOUR}/hour`;
  if (since(DAY_MS) >= ACK_MAX_PER_DAY) return `${ACK_MAX_PER_DAY}/day`;
  return null;
}
