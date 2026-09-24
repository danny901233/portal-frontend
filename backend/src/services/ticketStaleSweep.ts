/**
 * What happens to a Pending ticket when the customer never replies.
 *
 * Pending means "we wrote, we are waiting". Left alone it waits forever, out
 * of sight of a queue that opens on New. So, measured from OUR last message:
 *
 *   day 3  — stale. Counted in the Stale chip, listed by the stale filter, and
 *            the assignee (or the whole team if unassigned) is nudged ONCE.
 *            Nobody chases the customer: Dan's call, 2026-09-24 — a chaser
 *            reads as pushy on a complaint and pointless on a supplier.
 *   day 7  — closed, with a line in the thread saying why. A reply from the
 *            customer reopens it through the inbound webhook like any other
 *            closed ticket, so closing costs nothing if they were just slow.
 *
 * The clock is lastStaffActivityAt, not lastCustomerActivityAt: if someone
 * sent a manual chaser on day 2, the silence starts again from there. A
 * ticket put into Pending by hand with no staff message falls back to the
 * customer's last activity so it cannot sit un-aged.
 */
import { Prisma, TicketEntryKind, TicketStatus } from '@prisma/client';
import { prisma } from '../db.js';
import { notifyReceptionMateStaff, notifyUser } from '../utils/push.js';

export const STALE_AFTER_DAYS = 3;
export const CLOSE_AFTER_DAYS = 7;
const SWEEP_INTERVAL_MS = 30 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Pending tickets whose last message from us is older than `days`. Shared by
 *  the sweep, the queue count and the list filter so all three agree on what
 *  "stale" means. */
export function staleWhere(days: number, now = new Date()): Prisma.TicketWhereInput {
  const cutoff = new Date(now.getTime() - days * DAY_MS);
  return {
    status: TicketStatus.pending,
    OR: [
      { lastStaffActivityAt: { lt: cutoff } },
      { lastStaffActivityAt: null, lastCustomerActivityAt: { lt: cutoff } },
    ],
  };
}

async function nudgeStale(now: Date): Promise<void> {
  const due = await prisma.ticket.findMany({
    where: { ...staleWhere(STALE_AFTER_DAYS, now), staleNudgedAt: null },
    select: {
      id: true, number: true, title: true, assigneeId: true,
      contact: { select: { name: true, email: true, phone: true } },
    },
    take: 100,
  });
  for (const t of due) {
    const who = t.contact.name?.trim() || t.contact.email || t.contact.phone || 'the customer';
    const payload = {
      title: `No reply for ${STALE_AFTER_DAYS} days`,
      subtitle: who,
      body: `#${t.number} · ${t.title}`,
      data: { type: 'ticket', ticketId: t.id, ticketNumber: t.number, category: 'TICKET' },
    };
    try {
      // Mark first so a push failure cannot re-nudge every half hour.
      await prisma.$transaction([
        prisma.ticket.update({ where: { id: t.id }, data: { staleNudgedAt: now } }),
        prisma.ticketEntry.create({
          data: {
            ticketId: t.id,
            kind: TicketEntryKind.status_change,
            body: `No reply from ${who} for ${STALE_AFTER_DAYS} days — ${t.assigneeId ? 'assignee' : 'team'} nudged. Closes on day ${CLOSE_AFTER_DAYS} if still silent.`,
          },
        }),
      ]);
      if (t.assigneeId) await notifyUser(t.assigneeId, payload);
      else await notifyReceptionMateStaff(payload);
      console.log(`[TICKET_STALE] #${t.number} stale — nudged ${t.assigneeId ? t.assigneeId : 'all staff'}`);
    } catch (err) {
      console.error(`[TICKET_STALE] nudge failed for #${t.number}:`, err);
    }
  }
}

async function closeSilent(now: Date): Promise<void> {
  const due = await prisma.ticket.findMany({
    where: staleWhere(CLOSE_AFTER_DAYS, now),
    select: { id: true, number: true, contact: { select: { name: true, email: true, phone: true } } },
    take: 100,
  });
  for (const t of due) {
    const who = t.contact.name?.trim() || t.contact.email || t.contact.phone || 'the customer';
    try {
      await prisma.$transaction([
        prisma.ticket.update({
          where: { id: t.id },
          data: { status: TicketStatus.closed, closedAt: now },
        }),
        prisma.ticketEntry.create({
          data: {
            ticketId: t.id,
            kind: TicketEntryKind.status_change,
            body: `Closed — no reply from ${who} for ${CLOSE_AFTER_DAYS} days. A reply will reopen it.`,
          },
        }),
      ]);
      console.log(`[TICKET_STALE] #${t.number} closed after ${CLOSE_AFTER_DAYS} days of silence`);
    } catch (err) {
      console.error(`[TICKET_STALE] close failed for #${t.number}:`, err);
    }
  }
}

export async function sweepStaleTickets(now = new Date()): Promise<void> {
  try {
    // Close first so a ticket that is both due a nudge and due to close (the
    // sweep was down for a week) does not get a nudge for something already gone.
    await closeSilent(now);
    await nudgeStale(now);
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
