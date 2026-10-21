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
export const STATUS_RANK: Record<string, number> = {
  sent: 1,
  delivered: 2,
  read: 3,
  failed: 4,
};

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
  const next = STATUS_RANK[incoming];
  // An unknown status is ignored rather than thrown: this runs inside a webhook loop, and
  // throwing would lose the rest of the batch along with it. Meta adds values over time.
  if (!next) return null;
  if (current && STATUS_RANK[current] >= next) return null;

  if (incoming === 'failed') {
    const err = errors && errors[0];
    return {
      deliveryStatus: 'failed',
      failedReason: err && err.title
        ? `${err.title}${err.code != null ? ` (${err.code})` : ''}`
        : 'Delivery failed',
    };
  }
  if (incoming === 'delivered') return { deliveryStatus: 'delivered', deliveredAt: at };
  if (incoming === 'read') return { deliveryStatus: 'read', readAt: at };
  return { deliveryStatus: 'sent' };
}
