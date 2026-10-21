/**
 * Order of operations for an outbound reply: send it, THEN record it.
 *
 * It used to be the other way round on every path, and that is how a garage came to believe it
 * had answered a customer it had not. 21 Oct 2026: one garage's WABA was blocked by Meta for 38
 * hours; six customers wrote in, eight replies were written into the portal and shown to staff
 * as sent, and not one left the building. A reply recorded before it is sent is a claim we have
 * not earned.
 *
 * Shared by the staff route (routes/messages.ts) and the agent's delayed reply
 * (services/chatDelay.ts) on purpose. They had separate copies of the send logic, and the last
 * time two WhatsApp paths drifted apart — one resolving its token, the other not — a garage's
 * staff replies failed silently for ten days while its agent carried on fine.
 *
 * Widget and livechat threads are deliberately NOT reordered: they have no external connection
 * and the row IS the delivery, which the customer's browser picks up. Reordering those would
 * break the one channel that works by writing to the database.
 *
 * Dependencies are injected so the ordering itself is testable — it is the ordering, not the
 * sending, that was the bug.
 */

const EXTERNAL_SEND_PLATFORMS = ['whatsapp', 'facebook', 'instagram'];

export interface ReplyDeps {
  /**
   * Deliver the text. Resolves with Meta's own message id (wamid) when there is one — that id
   * is what later lets a delivered/read/failed status webhook find this message again, so a
   * send that returns one and does not store it throws away the only delivery evidence we get.
   */
  send: (content: string) => Promise<{ providerMessageId?: string | null } | void>;
  record: (content: string, providerMessageId: string | null) => Promise<{ id: string }>;
  touchConversation: () => Promise<void>;
  flagUndelivered: (reason: string) => Promise<void>;
}

export type ReplyResult =
  | { ok: true; message: { id: string } }
  | { ok: false; status: number; error: string };

export async function deliverReply(
  platform: string,
  content: string,
  hasConnection: boolean,
  deps: ReplyDeps,
): Promise<ReplyResult> {
  let providerMessageId: string | null = null;

  if (EXTERNAL_SEND_PLATFORMS.includes(platform)) {
    if (!hasConnection) {
      // This used to write the row and skip the send without a word, which reads to the garage
      // as a delivered reply on a channel we are not even connected to.
      const error = `This ${platform} conversation has no active connection, so the reply was not sent.`;
      await deps.flagUndelivered(error);
      return { ok: false, status: 502, error };
    }
    try {
      const sent = await deps.send(content);
      providerMessageId = (sent && sent.providerMessageId) || null;
    } catch (e: any) {
      const raw = String(e?.message || 'unknown error');
      await deps.flagUndelivered(raw);
      // An expired window is the customer having gone quiet for a day — the garage can act on
      // that. Anything else is ours or Meta's, and must not be dressed up as the customer's doing.
      if (raw.includes('24-hour messaging window')) {
        return { ok: false, status: 400, error: raw };
      }
      return {
        ok: false,
        status: 502,
        error: `Your reply could not be sent and has NOT reached the customer — ${raw}`,
      };
    }
  }

  const message = await deps.record(content, providerMessageId);
  await deps.touchConversation();
  return { ok: true, message };
}
