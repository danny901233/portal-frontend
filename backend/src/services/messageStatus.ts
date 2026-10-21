/**
 * Meta delivery receipts for a conversation reply.
 *
 * WhatsApp posts sent → delivered → read, or failed, to the same webhook the outbound campaigns
 * have always used (routes/webhooks/meta-whatsapp.ts). Campaigns consumed it because they store
 * the message id Meta hands back; conversation replies never did, so every receipt for a chat
 * reply was parsed and thrown away.
 *
 * This earns its place beyond reporting: a `failed` status can arrive AFTER Meta has answered the
 * send with 200 OK. Sending before recording catches a synchronous refusal; only this catches a
 * message Meta accepted and then could not deliver.
 */

// `failed` outranks everything deliberately. A failure arriving after a read is odd but must
// never be masked by one — an undelivered message is the thing the garage has to know about.
//
// A Map, not an object literal. The status string comes off a webhook, and a plain object
// answers for keys it does not own: STATUS_RANK['constructor'] is the Function constructor,
// which is truthy, so an unknown-status guard written as `if (!rank) return null` let
// "constructor" through and recorded the message as sent.
const RANK = new Map<string, number>([
  ['sent', 1],
  ['delivered', 2],
  ['read', 3],
  ['failed', 4],
]);

/** Exposed for tests and for anything that needs to compare two statuses. */
export const STATUS_RANK = Object.freeze(Object.fromEntries(RANK)) as Readonly<Record<string, number>>;

/** The longest failure text we will store — it is Meta's words, going into a column and a page. */
const MAX_REASON = 300;

export interface MetaStatusError {
  code?: number | string;
  title?: string;
}

export interface MessageStatusUpdate {
  deliveryStatus: string;
  deliveredAt?: Date;
  readAt?: Date;
  failedReason?: string;
}

/**
 * What to write for an incoming status, or null to ignore it.
 *
 * Returns null when the status would not move the message forward. Meta does not promise
 * ordering and it retries, so a late `sent` after a `read` is normal traffic — applying it would
 * rewind the message to looking undelivered and invent a fault that does not exist.
 */
export function statusUpdate(
  current: string | null,
  incoming: string,
  at: Date,
  errors?: MetaStatusError[],
): MessageStatusUpdate | null {
  const next = RANK.get(incoming);
  // An unknown status is ignored rather than thrown: this runs inside a webhook loop, and
  // throwing would lose the rest of the batch along with it. Meta adds values over time.
  if (next === undefined) return null;
  // A current value we do not recognise ranks as nothing, so it can never discard a real
  // incoming status — least of all a failure.
  const now = current === null ? 0 : (RANK.get(current) ?? 0);
  if (now >= next) return null;

  if (incoming === 'failed') {
    const err = errors && errors[0];
    const reason = err && err.title
      ? `${err.title}${err.code != null ? ` (${err.code})` : ''}`
      : 'Delivery failed';
    return {
      deliveryStatus: 'failed',
      failedReason: reason.slice(0, MAX_REASON),
    };
  }
  if (incoming === 'delivered') return { deliveryStatus: 'delivered', deliveredAt: at };
  if (incoming === 'read') return { deliveryStatus: 'read', readAt: at };
  return { deliveryStatus: 'sent' };
}
