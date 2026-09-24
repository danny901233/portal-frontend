/**
 * What happens to a Pending ticket when the customer never replies.
 *
 * Pending means "we wrote, we are waiting". Left alone it waits forever, out of
 * sight of a queue that opens on New. So, measured from OUR last message, and
 * ONLY once we have actually sent one (Dan, 2026-09-24 — a ticket nobody has
 * answered is our problem, not the customer's, and must never age out):
 *
 *   day 2 — a reminder goes to the customer on the same ticket: still need a
 *           hand? reply; otherwise we close in three days. Counted in the
 *           Stale chip and listed by the stale filter from here.
 *   day 5 — closed, and the customer is told, with a line in the thread saying
 *           why. Their reply reopens it through the inbound webhook like any
 *           other closed ticket, so closing costs nothing if they were just slow.
 *
 * The clock is lastStaffActivityAt. The reminder and the closing notice are
 * automatic, so they deliberately do NOT bump it — otherwise the reminder would
 * push the close out to day 7. A manual chaser from a person does bump it, and
 * that is right: the silence starts again.
 */
import { Prisma, TicketChannel, TicketEntryKind, TicketStatus } from '@prisma/client';
import { prisma } from '../db.js';
import { sendTicketEmail } from './ticketEmail.js';

export const REMIND_AFTER_DAYS = 2;
export const CLOSE_AFTER_DAYS = 5;
const SWEEP_INTERVAL_MS = 30 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Pending tickets we have replied to, whose last message from us is older
 *  than `days`. Shared by the sweep, the queue count and the list filter so
 *  all three agree on what "stale" means. */
export function staleWhere(days: number, now = new Date()): Prisma.TicketWhereInput {
  const cutoff = new Date(now.getTime() - days * DAY_MS);
  return {
    status: TicketStatus.pending,
    lastStaffActivityAt: { lt: cutoff },
  };
}

const firstName = (name: string | null): string => (name?.trim() ? name.trim().split(/\s+/)[0] : '');
const greet = (name: string | null): string => (firstName(name) ? `Hi ${firstName(name)},` : 'Hi,');

const reminderBody = (name: string | null): string => [
  greet(name),
  '',
  `We replied to your message a couple of days ago and haven't heard back, so we just wanted to check whether you still need a hand with this.`,
  '',
  `If you do, simply reply to this email and it will come straight back to the same person. If we don't hear from you in the next ${CLOSE_AFTER_DAYS - REMIND_AFTER_DAYS} days we'll close this ticket — you can reopen it at any time by replying.`,
].join('\n');

const closingBody = (name: string | null): string => [
  greet(name),
  '',
  `As we haven't heard back from you, we've closed this ticket for now.`,
  '',
  `If you still need help, just reply to this email and it will reopen automatically and come straight back to us.`,
].join('\n');

type Due = {
  id: string; number: number; title: string; channel: TicketChannel;
  contact: { name: string | null; email: string | null; blocked: boolean };
};

const dueSelect = {
  id: true, number: true, title: true, channel: true,
  contact: { select: { name: true, email: true, blocked: true } },
} as const;

/** Send an automatic email on the ticket and record it in the thread as ours.
 *  Returns the entry data so the caller can commit it with its own changes. */
async function sendAutomatic(t: Due, kind: 'reminder' | 'closing', body: string) {
  const sent = await sendTicketEmail({
    ticketId: t.id, ticketNumber: t.number, title: t.title, to: t.contact.email as string, body,
  });
  const entry: Prisma.TicketEntryCreateManyInput = {
    ticketId: t.id,
    kind: TicketEntryKind.public_reply,
    body,
    isDraft: false,
    outboundMessageId: sent.outboundMessageId,
    meta: {
      automatic: kind,
      threadingHeaders: sent.threadingHeaders,
      sentAt: new Date().toISOString(),
      ...(sent.sendOk ? {} : { sendFailed: true }),
    } as Prisma.InputJsonValue,
  };
  return { sent, entry };
}

const canEmail = (t: Due): boolean => t.channel === TicketChannel.email && !!t.contact.email && !t.contact.blocked;

async function remind(now: Date): Promise<void> {
  const due = await prisma.ticket.findMany({
    where: { ...staleWhere(REMIND_AFTER_DAYS, now), reminderSentAt: null },
    select: dueSelect,
    take: 100,
  });
  for (const t of due) {
    try {
      if (!canEmail(t)) {
        // Nothing to send on (WhatsApp/phone tickets, or no address). Mark it so
        // we do not re-evaluate every half hour; it still closes on day 5.
        await prisma.ticket.update({ where: { id: t.id }, data: { reminderSentAt: now } });
        continue;
      }
      const { sent, entry } = await sendAutomatic(t, 'reminder', reminderBody(t.contact.name));
      await prisma.$transaction([
        prisma.ticket.update({ where: { id: t.id }, data: { reminderSentAt: now } }),
        prisma.ticketEntry.create({ data: entry }),
      ]);
      console.log(`[TICKET_STALE] #${t.number} reminder ${sent.sendOk ? 'sent' : 'FAILED'} to ${t.contact.email}`);
    } catch (err) {
      console.error(`[TICKET_STALE] reminder failed for #${t.number}:`, err);
    }
  }
}

async function close(now: Date): Promise<void> {
  const due = await prisma.ticket.findMany({
    where: staleWhere(CLOSE_AFTER_DAYS, now),
    select: dueSelect,
    take: 100,
  });
  for (const t of due) {
    const who = t.contact.name?.trim() || t.contact.email || 'the customer';
    try {
      const ops: Prisma.PrismaPromise<unknown>[] = [
        prisma.ticket.update({ where: { id: t.id }, data: { status: TicketStatus.closed, closedAt: now } }),
      ];
      let told = false;
      if (canEmail(t)) {
        const { sent, entry } = await sendAutomatic(t, 'closing', closingBody(t.contact.name));
        ops.push(prisma.ticketEntry.create({ data: entry }));
        told = sent.sendOk;
      }
      ops.push(prisma.ticketEntry.create({
        data: {
          ticketId: t.id,
          kind: TicketEntryKind.status_change,
          body: `Closed — no reply from ${who} for ${CLOSE_AFTER_DAYS} days${told ? ', customer emailed' : ''}. A reply will reopen it.`,
        },
      }));
      await prisma.$transaction(ops);
      console.log(`[TICKET_STALE] #${t.number} closed after ${CLOSE_AFTER_DAYS} days of silence${told ? ' (customer told)' : ''}`);
    } catch (err) {
      console.error(`[TICKET_STALE] close failed for #${t.number}:`, err);
    }
  }
}

export async function sweepStaleTickets(now = new Date()): Promise<void> {
  try {
    // Close first so a ticket that is both due a reminder and due to close (the
    // sweep was down for a week) is not reminded about something already gone.
    await close(now);
    await remind(now);
  } catch (err) {
    console.error('[TICKET_STALE] sweep failed:', err);
  }
}

let timer: NodeJS.Timeout | null = null;

export function startTicketStaleSweep(intervalMs = SWEEP_INTERVAL_MS): void {
  if (timer) return;
  void sweepStaleTickets();
  timer = setInterval(() => void sweepStaleTickets(), intervalMs);
}
