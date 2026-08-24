// Auto-derives the enquiryType tag for a ChatConversation. Used by the
// garage-side Messages inbox to filter by "kind of enquiry" without asking
// staff to hand-classify. Dan's rule: tags are display-only, they must NOT
// influence what the agent says — so this lives outside the agent decision
// path and is only ever read from what the agent has already decided
// (session.intent, session.step).
//
// Values (kept in sync with the frontend filter chip labels):
//   complaint  — customer is upset / demanding a refund / calling out bad service
//   booking    — customer intends to book a job in
//   sales      — customer wants a price / quote first
//   general    — everything else: enquiries, messages, questions
//   parts      — deliberately NOT auto-derived; only staff hand-tag today
//                (documented as follow-up)
//
// Returning null means "we don't know" — the caller must NOT overwrite an
// existing tag with null.

import { prisma } from '../db.js';

// Higher number wins when we already have a tag and derive a new one. Complaints
// always trump booking/sales because they change how a garage triages the
// conversation. Booking beats sales because a booking intent is a stronger
// commercial signal than a price ask.
const PRIORITY: Record<string, number> = {
  complaint: 4,
  booking: 3,
  sales: 2,
  general: 1,
  parts: 3, // hand-tagged; treated as commit-strength so auto-derive won't overwrite
};

export type EnquiryType = 'complaint' | 'booking' | 'sales' | 'general' | 'parts';

/**
 * Read the session state that the agent has already computed and pick the
 * best label. Returns null when we can't classify — never guess.
 *
 * We deliberately do NOT re-run the complaint regex here. chatAgentV2 already
 * routes complaint messages to intent='message' + step=MESSAGE_ONLY (see the
 * complaintSignals check at the top of run()). Duplicating that logic here
 * would risk drift, and running it against every save (including tool-turn
 * saves that don't carry a user message) would be either noisy or wrong.
 */
export function deriveEnquiryTypeFromSession(
  session: { intent?: string | null; step?: string | null } | null | undefined,
): EnquiryType | null {
  const intent = session?.intent;
  const step = session?.step;

  // Complaint fingerprint: message-only branch reached via the complaint regex.
  // Step.MESSAGE_ONLY is the string 'message_only' at runtime.
  if (intent === 'message' && step === 'message_only') return 'complaint';

  switch (intent) {
    case 'booking':
      return 'booking';
    case 'quote':
      return 'sales';
    case 'message':
      return 'general';
    default:
      return null;
  }
}

/**
 * Persist the derived enquiryType on the conversation row iff it's a stronger
 * signal than what's already there (or the row has none yet). Safe to call on
 * every message write — no-op when nothing changes.
 */
export async function maybeUpdateEnquiryType(
  conversationId: string,
  derived: EnquiryType | null,
): Promise<void> {
  if (!derived) return;
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ enquiryType: string | null }>>(
      `SELECT "enquiryType" FROM "ChatConversation" WHERE id = $1`,
      conversationId,
    );
    const current = rows[0]?.enquiryType ?? null;
    if (current === derived) return;
    const currentP = current ? (PRIORITY[current] ?? 0) : 0;
    const derivedP = PRIORITY[derived] ?? 0;
    if (derivedP <= currentP) return;
    await prisma.$executeRawUnsafe(
      `UPDATE "ChatConversation" SET "enquiryType" = $1 WHERE id = $2`,
      derived,
      conversationId,
    );
  } catch (err) {
    // Tagging is best-effort — never fail a conversation save because we
    // couldn't classify it.
    console.error(`[ENQUIRY_TYPE] Failed to update for ${conversationId}:`, err);
  }
}
