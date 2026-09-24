/**
 * The notification a new ticket sends to the team.
 *
 * Kept apart from the inbound webhook because of WHEN it fires. The obvious
 * moment is the instant the ticket is created, and that is what we did first —
 * but the AI draft lands two to five seconds later, so the payload went out
 * before the most useful thing in it existed. Long-pressing the notification
 * showed a subject line and nothing to act on.
 *
 * So the push waits for enrichment, with a deadline. A slow or failed OpenAI
 * call must never mean no notification at all: after the deadline it goes
 * anyway, just without a draft. Late is recoverable, silent is not.
 *
 * Everything the phone needs is in the payload — an expanded notification gets
 * no chance to make network calls — including a reply token minted per staff
 * member so a reply typed on the lock screen is attributed to whoever sent it.
 */
import { TicketEntryKind } from '@prisma/client';
import { prisma } from '../db.js';
import { notifyStaffIndividually } from '../utils/push.js';
import { mintPushReplyToken } from './pushReplyToken.js';

/** How long to wait for the AI draft before notifying without one. */
const DRAFT_WAIT_MS = 12_000;
const POLL_MS = 750;

/** APNs payloads are capped at 4KB; a draft and a message excerpt fit easily,
 *  but an essay-length email does not. */
const MESSAGE_LIMIT = 900;
const DRAFT_LIMIT = 1200;

async function latestDraftBody(ticketId: string): Promise<string | null> {
  const draft = await prisma.ticketEntry.findFirst({
    where: { ticketId, kind: TicketEntryKind.public_reply, isDraft: true },
    orderBy: { createdAt: 'desc' },
    select: { body: true },
  });
  return draft?.body ?? null;
}

/** Poll for the draft rather than coupling to the enrichment promise: the draft
 *  is written by a fire-and-forget task that may fail, and this way a failure
 *  simply means the deadline is reached. */
async function waitForDraft(ticketId: string): Promise<string | null> {
  const deadline = Date.now() + DRAFT_WAIT_MS;
  while (Date.now() < deadline) {
    const body = await latestDraftBody(ticketId);
    if (body) return body;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return null;
}

export async function pushNewTicketToStaff(ticketId: string): Promise<void> {
  try {
    const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId },
      include: { contact: { select: { name: true, email: true, phone: true } } },
    });
    if (!ticket) return;

    const firstMessage = await prisma.ticketEntry.findFirst({
      where: { ticketId, kind: TicketEntryKind.public_reply, authorContactId: { not: null } },
      orderBy: { createdAt: 'asc' },
      select: { body: true },
    });

    const draft = await waitForDraft(ticketId);
    if (!draft) {
      console.log(`[TICKET_PUSH] ticket #${ticket.number}: no draft within ${DRAFT_WAIT_MS}ms — notifying without one`);
    }

    const who = ticket.contact.name?.trim()
      || ticket.contact.email
      || ticket.contact.phone
      || 'Someone';

    await notifyStaffIndividually((userId) => ({
      title: 'New support ticket',
      subtitle: who,
      body: ticket.title,
      data: {
        type: 'ticket',
        ticketId: ticket.id,
        ticketNumber: ticket.number,
        // Drives the notification category on the phone: the expanded view and
        // its Send / Edit buttons only appear when there is a draft to act on.
        category: draft ? 'TICKET_WITH_DRAFT' : 'TICKET',
        message: (firstMessage?.body ?? '').slice(0, MESSAGE_LIMIT),
        draft: draft ? draft.slice(0, DRAFT_LIMIT) : '',
        replyToken: mintPushReplyToken({ ticketId: ticket.id, userId }) ?? '',
      },
    }));
  } catch (err) {
    console.error('[TICKET_PUSH] failed:', err);
  }
}
