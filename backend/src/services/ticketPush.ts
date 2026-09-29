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
import { TicketCategory, TicketEntryKind, TicketStatus } from '@prisma/client';
import { prisma } from '../db.js';
import { notifyStaffIndividually, notifyUser } from '../utils/push.js';
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

    // The wait is also the window in which the classifier files spam. A
    // ticket that was closed or tagged spam while we waited is not news.
    const latest = await prisma.ticket.findUnique({
      where: { id: ticketId },
      select: { status: true, category: true },
    });
    if (!latest || latest.status === TicketStatus.closed || latest.category === TicketCategory.spam) {
      console.log(`[TICKET_PUSH] ticket #${ticket.number}: filed as ${latest?.category ?? 'gone'}/${latest?.status ?? '-'} while waiting — not notifying`);
      return;
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

/**
 * A customer has written back on a ticket that already exists.
 *
 * Separate from the new-ticket push, and deliberately leaner. There is no AI
 * draft on a reply — we do not draft one, because a fresh suggestion on every
 * turn would fill the thread — so there is nothing to wait for and it goes out
 * at once. The reply token still rides along, which is the point: the useful
 * thing to do with "they have answered" is answer back.
 *
 * Goes to the assignee alone when the ticket has one. Somebody else's
 * conversation buzzing your phone is the noise that makes people turn
 * notifications off; an unassigned ticket is nobody's, so the team gets it.
 */
export async function pushCustomerReply(ticketId: string): Promise<void> {
  try {
    const ticket = await prisma.ticket.findUnique({
      where: { id: ticketId },
      select: {
        id: true, number: true, title: true, status: true, category: true, assigneeId: true,
        contact: { select: { name: true, email: true, phone: true } },
      },
    });
    if (!ticket) return;
    // Filed away by a rule, or marked as spam by a person: not news.
    if (ticket.status === TicketStatus.closed || ticket.category === TicketCategory.spam) return;

    const latest = await prisma.ticketEntry.findFirst({
      where: { ticketId, kind: TicketEntryKind.public_reply, authorContactId: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { body: true },
    });

    const who = ticket.contact.name?.trim()
      || ticket.contact.email
      || ticket.contact.phone
      || 'Someone';

    const build = (userId: string) => ({
      title: `${who} replied`,
      subtitle: `#${ticket.number} · ${ticket.title}`.slice(0, 120),
      body: (latest?.body ?? '').slice(0, MESSAGE_LIMIT) || 'Open the ticket to read it.',
      data: {
        type: 'ticket',
        ticketId: ticket.id,
        ticketNumber: ticket.number,
        // No draft exists on a reply, so the expanded view offers Reply only.
        category: 'TICKET',
        message: (latest?.body ?? '').slice(0, MESSAGE_LIMIT),
        draft: '',
        replyToken: mintPushReplyToken({ ticketId: ticket.id, userId }) ?? '',
      },
    });

    if (ticket.assigneeId) {
      await notifyUser(ticket.assigneeId, build(ticket.assigneeId));
      console.log(`[TICKET_PUSH] #${ticket.number}: reply from ${who} → assignee`);
    } else {
      await notifyStaffIndividually(build);
      console.log(`[TICKET_PUSH] #${ticket.number}: reply from ${who} → all staff (unassigned)`);
    }
  } catch (err) {
    console.error('[TICKET_PUSH] reply push failed:', err);
  }
}
