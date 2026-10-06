// Support hub Phase 2 continuation — ticket-model routes.
// Reads/writes the Ticket / Contact / TicketEntry tables added in PR #381.
//
// Staff-only. All endpoints go through requireAdmin.
//
// Endpoints:
//   GET    /api/admin/tickets                — list with filters (status, assignee, channel, category, garageId)
//   GET    /api/admin/tickets/queue-counts   — sidebar counts (unassigned, mine open, pending 3+ days)
//   GET    /api/admin/tickets/sent           — what we have SENT, newest first, with delivery status
//   GET    /api/admin/tickets/:id            — one ticket + all entries in chronological order
//   POST   /api/admin/tickets                — create a ticket (for seeding + testing; production ingest is Phase 1/3/4)
//   POST   /api/admin/tickets/:id/reply      — post a public_reply (sends to customer once channel-send is wired up)
//   POST   /api/admin/tickets/:id/note       — post an internal_note (staff-only, never sent out)
//   PATCH  /api/admin/tickets/:id/status     — status transition + logs a status_change entry
//   PATCH  /api/admin/tickets/:id/assign     — assignment change + logs an assignment_change entry
//   POST   /api/admin/tickets/compose        — start a conversation: new ticket + first message sent by us (optional cc)
//   POST   /api/admin/tickets/:id/spam       — file as spam, close, block the sender at ingest
//   POST   /api/admin/tickets/:id/not-spam   — undo: unblock the sender, reopen in the queue
//
// Not in this file:
//   - Actual outbound sending (email/whatsapp) — wired in Phase 1 / Phase 3
//   - AI classification of category on ingest — wired in Phase 1
//   - Contact merge / re-linking — deferred (per PR #381 doc)

import type { Request, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { Prisma, TicketStatus, TicketCategory, TicketPriority, TicketChannel, TicketEntryKind } from '@prisma/client';
import { prisma } from '../db.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { stripTicketTag, ticketNumberCandidates } from '../services/ticketRef.js';
import { sendTicketEmail } from '../services/ticketEmail.js';
import { fileTicketMail } from '../services/outlookMailbox.js';
import { verifyPushReplyToken } from '../services/pushReplyToken.js';
import { staleWhere, REMIND_AFTER_DAYS } from '../services/ticketStaleSweep.js';
import multer from 'multer';
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  claimAttachments,
  loadEntryAttachments,
  loadStagedAttachments,
  presignAttachment,
  stageAttachment,
  toEmailAttachments,
  validateTotalSize,
  validateUpload,
} from '../services/ticketAttachments.js';

const router = Router();

// ─── Status codec ──────────────────────────────────────────────────────────
// Prisma reserves `new` as an enum-value name (JS keyword), so the schema uses
// `TicketStatus.new_` with `@map("new")` — DB literal is still `"new"`. That
// mapping only applies to writes/reads at the DB layer; the runtime enum object
// still exposes the code-name `"new_"`, which would leak into JSON responses
// unless we translate at the API boundary. Do it here in one place.

const dbStatusOut = (s: TicketStatus): string => (s === TicketStatus.new_ ? 'new' : s);
const dbStatusIn  = (s: string): TicketStatus | null => {
  if (s === 'new') return TicketStatus.new_;
  return (Object.values(TicketStatus) as string[]).includes(s) ? (s as TicketStatus) : null;
};

const serializeTicket = <T extends { status: TicketStatus }>(t: T): Omit<T, 'status'> & { status: string } =>
  ({ ...t, status: dbStatusOut(t.status) });

// ─── Validation schemas ────────────────────────────────────────────────────

// Status uses DB literals (`'new'`, not `'new_'`) and coerces to the Prisma value.
// 'solved' is deliberately absent — retired 2026-09-29, see schema.prisma.
const statusEnum   = z.enum(['new', 'open', 'pending', 'on_hold', 'closed'])
                      .transform((v) => dbStatusIn(v) as TicketStatus);
const categoryEnum = z.nativeEnum(TicketCategory);
const priorityEnum = z.nativeEnum(TicketPriority);
const channelEnum  = z.nativeEnum(TicketChannel);

const createTicketSchema = z.object({
  title: z.string().trim().min(1).max(300),
  channel: channelEnum,
  priority: priorityEnum.optional(),
  category: categoryEnum.optional(),
  // Contact identity — email OR phone must be set. If a Contact with the given
  // email/phone exists we reuse it, otherwise we create a new one on the fly.
  contact: z.object({
    email: z.string().email().optional(),
    phone: z.string().trim().min(3).max(30).optional(),
    name:  z.string().trim().max(120).optional(),
    garageId: z.string().optional(),  // cache onto ticket at create time
  }).refine((c) => !!(c.email || c.phone), { message: 'Contact needs email or phone' }),
  // Optional first message body — if provided, we create a public_reply entry
  // authored by the contact so the ticket opens with content.
  initialBody: z.string().trim().max(20000).optional(),
});

// Copied recipients. Capped because this is an outbound send from our support
// address: a long list is a mailing shot, not a conversation.
const ccSchema = z.array(z.string().trim().email().transform((v) => v.toLowerCase()))
  .max(10)
  .optional();

// Are we waiting on an answer? Drives the no-reply chase. Starting a
// conversation defaults to yes; replying to one defaults to no.
const chaseSchema = z.boolean().optional();

/** Ids from the upload endpoint. Staged files belonging to the sender, not yet on any entry. */
const attachmentIdsSchema = z.array(z.string().uuid()).max(MAX_ATTACHMENTS).optional();

const composeSchema = z.object({
  to: z.string().trim().email().transform((v) => v.toLowerCase()),
  cc: ccSchema,
  chase: chaseSchema,
  name: z.string().trim().max(120).optional(),
  subject: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1).max(20000),
  attachmentIds: attachmentIdsSchema,
});

const replySchema = z.object({
  body: z.string().trim().min(1).max(20000),
  isDraft: z.boolean().optional(),  // AI-drafted, not yet approved (default false = staff typed & sent)
  cc: ccSchema,
  chase: chaseSchema,
  attachmentIds: attachmentIdsSchema,
});

const statusChangeSchema = z.object({
  status: statusEnum,
});

const assignSchema = z.object({
  assigneeId: z.string().nullable(),  // null = unassigned (back to shared queue)
});

// ─── Helpers ───────────────────────────────────────────────────────────────

async function getOrCreateContact(
  input: { email?: string; phone?: string; name?: string; garageId?: string }
) {
  // Prefer email as the identity anchor (globally unique per PR #381 design decision).
  if (input.email) {
    const existing = await prisma.contact.findUnique({ where: { email: input.email } });
    if (existing) return existing;
  }
  return prisma.contact.create({
    data: {
      email: input.email,
      phone: input.phone,
      name:  input.name,
      garageId: input.garageId,
    },
  });
}

// ─── LIST ──────────────────────────────────────────────────────────────────

router.get('/admin/tickets', authenticate, requireAdmin, async (req: Request, res: Response) => {
  const q = req.query as Record<string, string | undefined>;
  const where: Prisma.TicketWhereInput = {};
  if (q.status) {
    const s = dbStatusIn(q.status);
    if (!s) return res.status(400).json({ error: `Invalid status: ${q.status}` });
    where.status = s;
  }
  if (q.assigneeId) where.assigneeId = q.assigneeId === 'unassigned' ? null : q.assigneeId;
  if (q.channel)    where.channel    = q.channel as TicketChannel;
  if (q.category)   where.category   = q.category as TicketCategory;
  if (q.priority)   where.priority   = q.priority as TicketPriority;
  if (q.garageId)   where.garageId   = q.garageId;
  // Pending with no reply for 2+ days — the Stale chip, as a list.
  if (q.stale === '1' || q.stale === 'true') Object.assign(where, staleWhere(REMIND_AFTER_DAYS));

  // Lookup by whatever the person has to hand: the reference a customer quoted
  // (RM-2SBXHMR), the internal number (#7), or a pasted subject line. Digits are
  // ambiguous between the two, so both readings are matched and at most one
  // exists. A reference search ignores the status filter — someone ringing about
  // a closed ticket still needs finding.
  if (q.ref) {
    const candidates = ticketNumberCandidates(q.ref);
    if (!candidates.length) return res.json({ tickets: [] });
    where.number = { in: candidates };
    delete where.status;
  }

  const take = Math.min(parseInt(q.limit || '50', 10), 200);

  const tickets = await prisma.ticket.findMany({
    where,
    orderBy: [{ updatedAt: 'desc' }],
    take,
    include: {
      contact:  { select: { id: true, email: true, phone: true, name: true } },
      assignee: { select: { id: true, email: true } },
      garage:   { select: { id: true, name: true } },
      _count:   { select: { entries: true } },
    },
  });

  return res.json({ tickets: tickets.map(serializeTicket) });
});

// ─── QUEUE COUNTS (sidebar) ────────────────────────────────────────────────

router.get('/admin/tickets/queue-counts', authenticate, requireAdmin, async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorised' });
  const [unassigned, mineOpen, pendingStale] = await Promise.all([
    prisma.ticket.count({ where: { assigneeId: null, status: { in: [TicketStatus.new_, TicketStatus.open] } } }),
    prisma.ticket.count({ where: { assigneeId: req.user.userId, status: TicketStatus.open } }),
    // Same definition as the sweep and the ?stale=1 list, so the chip's number
    // is the list's length.
    prisma.ticket.count({ where: staleWhere(REMIND_AFTER_DAYS) }),
  ]);

  return res.json({ unassigned, mineOpen, pendingStale });
});

// ─── DETAIL ────────────────────────────────────────────────────────────────

// ─── SENT ──────────────────────────────────────────────────────────────────
// Everything we have emailed out, newest first, as MESSAGES rather than
// tickets. Deliberately a different axis from the status filters: those answer
// "what needs doing", this answers "what did we send, and did it arrive". The
// second question had no home — a reply disappeared into Pending among the
// inbound conversations, and whether it reached anyone was invisible.
//
// Delivery comes from EmailLog, matched on the Message-Id we set when sending.
// No foreign key exists between the two, so it is a second query and a map
// rather than a join; a message with no row yet simply reads as pending.
//
// MUST stay above '/admin/tickets/:id' — Express would otherwise read "sent"
// as a ticket id and 404.

router.get('/admin/tickets/sent', authenticate, requireAdmin, async (req: Request, res: Response) => {
  const q = req.query as Record<string, string | undefined>;
  const take = Math.min(parseInt(q.limit || '50', 10), 200);

  const entries = await prisma.ticketEntry.findMany({
    where: {
      kind: TicketEntryKind.public_reply,
      isDraft: false,
      // Ours, not theirs: an inbound message has an author contact and never a
      // Message-Id of our making.
      outboundMessageId: { not: null },
    },
    orderBy: { createdAt: 'desc' },
    take,
    include: {
      authorUser: { select: { email: true } },
      ticket: {
        select: {
          id: true, number: true, title: true, status: true,
          contact: { select: { name: true, email: true } },
        },
      },
    },
  });

  const ids = entries.map((e) => e.outboundMessageId).filter((v): v is string => !!v);
  const logs = ids.length
    ? await prisma.emailLog.findMany({
        where: { providerMessageId: { in: ids } },
        select: { providerMessageId: true, status: true, to: true, cc: true, deliveredAt: true, failedAt: true, error: true },
      })
    : [];
  const byMessageId = new Map(logs.map((l) => [l.providerMessageId as string, l]));

  const messages = entries.map((e) => {
    const log = e.outboundMessageId ? byMessageId.get(e.outboundMessageId) : undefined;
    const meta = (e.meta && typeof e.meta === 'object' && !Array.isArray(e.meta))
      ? (e.meta as Record<string, unknown>)
      : {};
    return {
      id: e.id,
      ticketId: e.ticket.id,
      ticketNumber: e.ticket.number,
      ticketTitle: e.ticket.title,
      ticketStatus: dbStatusOut(e.ticket.status),
      to: log?.to ?? [e.ticket.contact.email].filter(Boolean),
      cc: log?.cc ?? (Array.isArray(meta.cc) ? (meta.cc as string[]) : []),
      recipientName: e.ticket.contact.name,
      // Who pressed send. No author and an automatic marker means the sweep.
      sentBy: e.authorUser?.email ?? (typeof meta.automatic === 'string' ? `Automatic (${meta.automatic})` : 'Automatic'),
      body: e.body.slice(0, 400),
      createdAt: e.createdAt,
      // 'sent' = accepted by Mailgun, nothing heard back yet. Anything else is
      // Mailgun telling us what became of it.
      delivery: log?.status ?? 'unknown',
      deliveredAt: log?.deliveredAt ?? null,
      failedAt: log?.failedAt ?? null,
      error: log?.error ?? null,
    };
  });

  return res.json({ messages });
});

router.get('/admin/tickets/:id', authenticate, requireAdmin, async (req: Request, res: Response) => {
  const ticket = await prisma.ticket.findUnique({
    where: { id: req.params.id },
    include: {
      contact:  { select: { id: true, email: true, phone: true, name: true, garageId: true, blocked: true } },
      assignee: { select: { id: true, email: true } },
      garage:   { select: { id: true, name: true } },
    },
  });
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  const entries = await prisma.ticketEntry.findMany({
    where: { ticketId: ticket.id },
    orderBy: { createdAt: 'asc' },
    take: 500,
    include: {
      authorUser:    { select: { id: true, email: true } },
      authorContact: { select: { id: true, email: true, name: true } },
      attachments:   { select: { id: true, filename: true, size: true, contentType: true },
                       orderBy: { createdAt: 'asc' } },
    },
  });

  return res.json({ ticket: serializeTicket(ticket), entries });
});

// ─── CREATE (seed / manual) ────────────────────────────────────────────────

router.post('/admin/tickets', authenticate, requireAdmin, async (req: Request, res: Response) => {
  const parsed = createTicketSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });

  const contact = await getOrCreateContact(parsed.data.contact);

  const ticket = await prisma.ticket.create({
    data: {
      title:    parsed.data.title,
      channel:  parsed.data.channel,
      priority: parsed.data.priority ?? TicketPriority.normal,
      category: parsed.data.category ?? TicketCategory.uncategorized,
      contactId: contact.id,
      garageId:  contact.garageId,
    },
  });

  if (parsed.data.initialBody) {
    await prisma.ticketEntry.create({
      data: {
        ticketId: ticket.id,
        kind: TicketEntryKind.public_reply,
        authorContactId: contact.id,
        body: parsed.data.initialBody,
      },
    });
  }

  return res.status(201).json({ ticket: serializeTicket(ticket) });
});

// ─── COMPOSE (outbound — we start the conversation) ────────────────────────
// The Zendesk shape: a new ticket whose first entry is ours, sent to the
// recipient from hello@ with the reference in the subject. Their reply threads
// back onto the same ticket through the inbound webhook like any other, so a
// query we raise with a customer or supplier lives in the queue with everything
// else instead of in someone's Outlook. Goes through postPublicReply so the
// subject tag, threading headers and the pending transition are the same as a
// reply's — the only difference is there was no inbound message first.

router.post('/admin/tickets/compose', authenticate, requireAdmin, async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorised' });
  const parsed = composeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });

  const contact = await getOrCreateContact({ email: parsed.data.to, name: parsed.data.name });
  if (contact.blocked) {
    return res.status(409).json({
      error: 'This address was marked as spam and is blocked, so their reply would be dropped. Open their ticket and choose Not spam first.',
    });
  }
  if (parsed.data.name && !contact.name) {
    await prisma.contact.update({ where: { id: contact.id }, data: { name: parsed.data.name } });
  }

  const ticket = await prisma.ticket.create({
    data: {
      title: stripTicketTag(parsed.data.subject) || parsed.data.subject,
      channel: TicketChannel.email,
      contactId: contact.id,
      garageId: contact.garageId,
      // Ours from the start.
      assigneeId: req.user.userId,
      status: TicketStatus.open,
    },
  });

  const result = await postPublicReply({
    ticketId: ticket.id,
    userId: req.user.userId,
    userEmail: req.user.email,
    body: parsed.data.body,
    cc: parsed.data.cc,
    // We wrote to them out of the blue; an answer is the whole point.
    chase: parsed.data.chase ?? true,
    attachmentIds: parsed.data.attachmentIds,
  });

  const fresh = await prisma.ticket.findUnique({ where: { id: ticket.id } });
  console.log(`[TICKETS] #${ticket.number} composed by ${req.user.email} to ${parsed.data.to} (send status=${result.status})`);
  // The ticket exists whatever happened to the send; the caller is told plainly
  // if the message did not leave, and the entry is there to retry from.
  return res.status(result.status === 201 ? 201 : result.status).json({
    ticket: serializeTicket(fresh ?? ticket),
    ...(result.error ? { error: result.error } : {}),
  });
});

// ─── REPLY (public — customer-facing) ──────────────────────────────────────

/**
 * Post a public reply and, where the channel allows it, actually send it.
 *
 * Extracted so the portal's reply box and a reply typed on a lock screen cannot
 * drift apart. Everything that makes a reply correct — the subject tag, the
 * threading headers, the status transition, refusing channels that cannot send —
 * has to happen identically whichever door it came through.
 *
 * `reuseEntryId` turns an existing AI draft INTO the sent reply rather than
 * creating a second identical entry beside it, so the thread reads as one
 * message and keeps the draft's provenance in its meta.
 */
async function postPublicReply(args: {
  ticketId: string;
  userId: string;
  userEmail?: string;
  body: string;
  isDraft?: boolean;
  reuseEntryId?: string;
  /** Copied recipients for THIS message. Deliberately not inherited from the
   *  ticket: a reply typed on a lock screen has no way to show who is copied,
   *  and silently re-copying people nobody can see is worse than not. The
   *  portal prefills the box from the last reply instead, where it is visible. */
  cc?: string[];
  /** True = we are waiting on an answer, so the sweep may chase for one.
   *  Undefined leaves the ticket as it is, which is how a lock-screen reply
   *  and an AI draft behave: neither can express the intent. */
  chase?: boolean;
  /** Staged uploads to send with this message. Scoped to `userId` when loaded, so a
   *  bare uuid from someone else's compose box cannot be attached here. */
  attachmentIds?: string[];
}): Promise<{ status: number; entry?: unknown; error?: string }> {
  const ticket = await prisma.ticket.findUnique({
    where: { id: args.ticketId },
    include: { contact: { select: { id: true, email: true, name: true } } },
  });
  if (!ticket) return { status: 404, error: 'Ticket not found' };

  const now = new Date();

  // Resolved before anything is sent or recorded, so a bad id fails the whole reply
  // rather than quietly sending it with fewer files than the sender chose.
  const staged = await loadStagedAttachments(args.attachmentIds ?? [], args.userId);
  if (staged.length !== (args.attachmentIds?.length ?? 0)) {
    return {
      status: 400,
      error: 'One of those attachments is no longer available — remove it and attach the file again.',
    };
  }
  const sizeCheck = validateTotalSize(staged.map((a) => a.size));
  if (!sizeCheck.ok) return { status: 400, error: sizeCheck.error };

  // Draft path: no email leaves the building, no timestamps bumped, no threading
  // headers generated. The UI still shows the draft.
  if (args.isDraft) {
    const entry = await prisma.ticketEntry.create({
      data: {
        ticketId: ticket.id,
        kind: TicketEntryKind.public_reply,
        authorUserId: args.userId,
        body: args.body,
        isDraft: true,
      },
    });
    // Held against the draft so approving it later sends the same files. Claiming them
    // now also takes them out of reach of the unsent-upload sweep.
    await claimAttachments(staged.map((a) => a.id), entry.id);
    return { status: 201, entry };
  }

  // Only wired for the email channel. Those other channels used to fall through
  // quietly: the entry was recorded, the timestamps moved, the UI showed a sent
  // reply, and nothing left the building. With phone tickets real, that silence
  // would be somebody believing they had answered a customer who never heard
  // from them. Refuse instead, and say why.
  const isEmailChannel = ticket.channel === TicketChannel.email;
  const canSendEmail = isEmailChannel && ticket.contact.email;

  if (!canSendEmail) {
    return {
      status: 409,
      error: ticket.channel === TicketChannel.phone
        ? 'This ticket came in by phone — ring them back, then add an internal note. Replies cannot be sent from here.'
        : isEmailChannel
          ? 'This contact has no email address, so a reply cannot be sent.'
          : `Replies on the ${ticket.channel} channel are not wired up yet — use an internal note.`,
    };
  }

  // Approving a draft sends what the draft was holding as well as anything added on the
  // way out, so a file chosen when the draft was written is not quietly dropped.
  const alreadyOnEntry = args.reuseEntryId ? await loadEntryAttachments(args.reuseEntryId) : [];
  const outgoing = [...alreadyOnEntry, ...staged];

  // Never copy the recipient on their own email.
  const cc = args.cc?.filter((a) => a && a !== ticket.contact.email) ?? [];
  const { sendOk, outboundMessageId, threadingHeaders } = await sendTicketEmail({
    ticketId: ticket.id,
    ticketNumber: ticket.number,
    title: ticket.title,
    to: ticket.contact.email as string,
    body: args.body,
    cc,
    attachments: outgoing.length ? await toEmailAttachments(outgoing) : undefined,
  });

  const sendMeta: Record<string, unknown> = {
    outboundMessageId,
    threadingHeaders,
    sentBy: args.userEmail,
    sentAt: now.toISOString(),
    // On the entry so the thread can show who else got it, and so the next
    // reply box can prefill with the same people.
    ...(cc.length ? { cc } : {}),
    ...(outgoing.length ? { attachments: outgoing.map((a) => a.filename) } : {}),
    ...(sendOk ? {} : { sendFailed: true }),
  };

  const entry = args.reuseEntryId
    ? await prisma.ticketEntry.update({
        where: { id: args.reuseEntryId },
        data: {
          isDraft: false,
          authorUserId: args.userId,
          outboundMessageId,
          meta: sendMeta as Prisma.InputJsonValue,
        },
      })
    : await prisma.ticketEntry.create({
        data: {
          ticketId: ticket.id,
          kind: TicketEntryKind.public_reply,
          authorUserId: args.userId,
          body: args.body,
          isDraft: false,
          outboundMessageId,
          meta: sendMeta as Prisma.InputJsonValue,
        },
      });

  // Attached to the entry whether or not the send succeeded: the files are part of
  // what staff composed, and an unsent entry is something they will retry from.
  await claimAttachments(staged.map((a) => a.id), (entry as { id: string }).id);

  await prisma.ticket.update({
    where: { id: ticket.id },
    data: {
      lastStaffActivityAt: now,
      firstResponseAt: ticket.firstResponseAt ?? now,
      ...(args.chase === undefined ? {} : { autoChase: args.chase }),
      // Sending a reply flips the ticket to pending (waiting on customer).
      status: ticket.status === TicketStatus.new_ || ticket.status === TicketStatus.open
        ? TicketStatus.pending
        : ticket.status,
    },
  });

  // The entry is recorded either way so staff can see and retry, but the caller
  // is told plainly when the customer never actually got it.
  if (!sendOk) return { status: 502, entry, error: 'Email send failed — entry saved as unsent' };
  return { status: 201, entry };
}

router.post('/admin/tickets/:id/reply', authenticate, requireAdmin, async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorised' });
  const parsed = replySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });

  const result = await postPublicReply({
    ticketId: req.params.id,
    userId: req.user.userId,
    userEmail: req.user.email,
    body: parsed.data.body,
    isDraft: parsed.data.isDraft ?? false,
    cc: parsed.data.cc,
    // A draft is not sent, so it says nothing about who we are waiting on.
    chase: parsed.data.isDraft ? undefined : (parsed.data.chase ?? false),
    attachmentIds: parsed.data.attachmentIds,
  });

  return res.status(result.status).json(
    result.error ? { entry: result.entry, error: result.error } : { entry: result.entry },
  );
});


// ─── ATTACHMENTS ───────────────────────────────────────────────────────────
//
// Upload is its own request, separate from sending, so the compose box can carry files
// before the ticket it belongs to exists. An upload is "staged" until a reply names its id;
// unclaimed ones are swept after a day (services/ticketAttachments.ts).

const attachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 },
});

/** Wrap multer so an oversized file answers 413 rather than a generic 500. */
const acceptOneFile = (req: Request, res: Response, next: (err?: unknown) => void) => {
  attachmentUpload.single('file')(req as never, res as never, (err: unknown) => {
    if (err) {
      const code = (err as { code?: string }).code;
      if (code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
          error: `That file is too large — the limit is ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB.`,
        });
      }
      console.error('[TICKETS] attachment upload failed:', err);
      return res.status(400).json({ error: 'That upload could not be read.' });
    }
    next();
  });
};

router.post('/admin/tickets/attachments', authenticate, requireAdmin, acceptOneFile, async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorised' });
  const file = (req as Request & { file?: { originalname: string; mimetype: string; size: number; buffer: Buffer } }).file;
  if (!file) return res.status(400).json({ error: 'No file uploaded.' });

  const check = validateUpload({
    filename: file.originalname,
    contentType: file.mimetype,
    size: file.size,
  });
  if (!check.ok) return res.status(400).json({ error: check.error });

  try {
    const staged = await stageAttachment({
      filename: file.originalname,
      contentType: file.mimetype,
      bytes: file.buffer,
      uploadedByUserId: req.user.userId,
    });
    console.log(`[TICKETS] ${req.user.email} staged attachment ${staged.filename} (${staged.size} bytes)`);
    return res.status(201).json({ attachment: staged });
  } catch (err) {
    console.error('[TICKETS] could not store attachment:', err);
    return res.status(502).json({ error: 'That file could not be stored. Try again.' });
  }
});

/**
 * A short-lived download link for one attachment.
 *
 * A URL rather than the bytes: the object is in a private bucket, and presigning keeps the
 * file out of the portal's own response path exactly as call recordings and chat media do.
 */
router.get('/admin/tickets/attachments/:id/url', authenticate, requireAdmin, async (req: Request, res: Response) => {
  try {
    const signed = await presignAttachment(req.params.id);
    if (!signed) return res.status(404).json({ error: 'Attachment not found' });
    return res.json(signed);
  } catch (err) {
    console.error('[TICKETS] could not presign attachment:', err);
    return res.status(502).json({ error: 'That attachment could not be fetched.' });
  }
});


// ─── REPLY FROM A NOTIFICATION ─────────────────────────────────────────────
// Deliberately NOT behind `authenticate`: this is called from the lock screen,
// where the portal session in the WebView's localStorage is out of reach. The
// token in the push payload is the credential — scoped to one ticket and one
// user, expiring in a day, and rejected by the normal middleware.

const pushReplySchema = z.object({
  token: z.string().min(10),
  // Either type a reply, or send the AI's draft as it stands.
  body: z.string().trim().min(1).max(20000).optional(),
  sendDraft: z.boolean().optional(),
});

router.post('/tickets/push-reply', async (req: Request, res: Response) => {
  const parsed = pushReplySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });

  const claims = verifyPushReplyToken(parsed.data.token);
  if (!claims) return res.status(401).json({ error: 'Link expired — open the ticket in the app' });

  const user = await prisma.user.findUnique({
    where: { id: claims.userId },
    select: { id: true, email: true, role: true },
  });
  if (!user || user.role !== 'RECEPTIONMATE_STAFF') {
    return res.status(403).json({ error: 'Not permitted' });
  }

  let body = parsed.data.body?.trim() ?? '';
  let reuseEntryId: string | undefined;

  if (parsed.data.sendDraft) {
    // Send what the AI actually wrote, not a copy typed from the screen — and
    // turn that draft into the sent message rather than leaving both in the
    // thread. If it has already gone, say so instead of sending it twice.
    const draft = await prisma.ticketEntry.findFirst({
      where: { ticketId: claims.ticketId, kind: TicketEntryKind.public_reply, isDraft: true },
      orderBy: { createdAt: 'desc' },
    });
    if (!draft) return res.status(409).json({ error: 'That draft has already been sent or removed' });
    body = draft.body;
    reuseEntryId = draft.id;
  }

  if (!body) return res.status(400).json({ error: 'Nothing to send' });

  const result = await postPublicReply({
    ticketId: claims.ticketId,
    userId: user.id,
    userEmail: user.email,
    body,
    reuseEntryId,
  });

  console.log(
    `[PUSH_REPLY] ticket ${claims.ticketId} ${parsed.data.sendDraft ? 'draft sent' : 'reply sent'} ` +
    `by ${user.email} from a notification (status=${result.status})`,
  );

  return res.status(result.status).json(result.error ? { error: result.error } : { ok: true });
});

// ─── NOTE (internal — never leaves the portal) ─────────────────────────────

router.post('/admin/tickets/:id/note', authenticate, requireAdmin, async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorised' });
  const parsed = replySchema.pick({ body: true }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });

  const ticket = await prisma.ticket.findUnique({ where: { id: req.params.id } });
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  const entry = await prisma.ticketEntry.create({
    data: {
      ticketId: ticket.id,
      kind: TicketEntryKind.internal_note,
      authorUserId: req.user.userId,
      body: parsed.data.body,
    },
  });
  return res.status(201).json({ entry });
});

// ─── STATUS CHANGE ─────────────────────────────────────────────────────────

router.patch('/admin/tickets/:id/status', authenticate, requireAdmin, async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorised' });
  const parsed = statusChangeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });

  const ticket = await prisma.ticket.findUnique({ where: { id: req.params.id } });
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  if (ticket.status === parsed.data.status) return res.json({ ticket: serializeTicket(ticket) });

  const now = new Date();
  const patch: Prisma.TicketUpdateInput = { status: parsed.data.status };
  if (parsed.data.status === TicketStatus.closed) patch.closedAt = now;

  const [updated] = await prisma.$transaction([
    prisma.ticket.update({ where: { id: ticket.id }, data: patch }),
    prisma.ticketEntry.create({
      data: {
        ticketId: ticket.id,
        kind: TicketEntryKind.status_change,
        authorUserId: req.user.userId,
        body: `Status: ${dbStatusOut(ticket.status)} → ${dbStatusOut(parsed.data.status)}`,
      },
    }),
  ]);

  // Keep the mailbox in step: closing files the original mail away, taking a
  // ticket back out of closed brings it back. Fire-and-forget on purpose.
  if (parsed.data.status === TicketStatus.closed) {
    void fileTicketMail(ticket.id, 'archive');
  } else if (ticket.status === TicketStatus.closed) {
    void fileTicketMail(ticket.id, 'inbox');
  }

  return res.json({ ticket: serializeTicket(updated) });
});

// ─── SPAM ──────────────────────────────────────────────────────────────────
// Marking spam is closing plus a promise: the sender's next email is dropped
// at ingest (Contact.blocked, checked by the Mailgun and WhatsApp handlers)
// instead of becoming another ticket to close. Any unsent AI draft goes too —
// nobody is replying to this. The ticket itself stays, so the block can be
// undone and the audit trail read.

router.post('/admin/tickets/:id/spam', authenticate, requireAdmin, async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorised' });
  const ticket = await prisma.ticket.findUnique({
    where: { id: req.params.id },
    include: { contact: { select: { id: true, email: true, phone: true, blocked: true } } },
  });
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  const now = new Date();
  const who = ticket.contact.email ?? ticket.contact.phone ?? 'sender';
  const [updated] = await prisma.$transaction([
    prisma.ticket.update({
      where: { id: ticket.id },
      data: { category: TicketCategory.spam, status: TicketStatus.closed, closedAt: now },
    }),
    prisma.contact.update({ where: { id: ticket.contact.id }, data: { blocked: true } }),
    prisma.ticketEntry.deleteMany({ where: { ticketId: ticket.id, isDraft: true } }),
    prisma.ticketEntry.create({
      data: {
        ticketId: ticket.id,
        kind: TicketEntryKind.status_change,
        authorUserId: req.user.userId,
        body: `Marked as spam — ${who} blocked`,
      },
    }),
  ]);
  void fileTicketMail(ticket.id, 'junkemail');
  console.log(`[TICKETS] #${ticket.number} marked as spam by ${req.user.email ?? req.user.userId}; blocked ${who}`);
  return res.json({ ticket: serializeTicket(updated) });
});

router.post('/admin/tickets/:id/not-spam', authenticate, requireAdmin, async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorised' });
  const ticket = await prisma.ticket.findUnique({
    where: { id: req.params.id },
    include: { contact: { select: { id: true, email: true, phone: true } } },
  });
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  const who = ticket.contact.email ?? ticket.contact.phone ?? 'sender';
  const [updated] = await prisma.$transaction([
    prisma.ticket.update({
      where: { id: ticket.id },
      data: {
        status: TicketStatus.open,
        closedAt: null,
        ...(ticket.category === TicketCategory.spam ? { category: TicketCategory.uncategorized } : {}),
      },
    }),
    prisma.contact.update({ where: { id: ticket.contact.id }, data: { blocked: false } }),
    prisma.ticketEntry.create({
      data: {
        ticketId: ticket.id,
        kind: TicketEntryKind.status_change,
        authorUserId: req.user.userId,
        body: `Not spam — ${who} unblocked, back in the queue`,
      },
    }),
  ]);
  void fileTicketMail(ticket.id, 'inbox');
  return res.json({ ticket: serializeTicket(updated) });
});

// ─── ASSIGN ────────────────────────────────────────────────────────────────

router.patch('/admin/tickets/:id/assign', authenticate, requireAdmin, async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorised' });
  const parsed = assignSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });

  const ticket = await prisma.ticket.findUnique({ where: { id: req.params.id } });
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  if (ticket.assigneeId === parsed.data.assigneeId) return res.json({ ticket: serializeTicket(ticket) });

  let noteBody = '';
  if (parsed.data.assigneeId === null) noteBody = 'Assignment cleared (back to shared queue)';
  else {
    const assignee = await prisma.user.findUnique({ where: { id: parsed.data.assigneeId }, select: { email: true } });
    if (!assignee) return res.status(400).json({ error: 'Assignee user not found' });
    noteBody = `Assigned to ${assignee.email}`;
  }

  const [updated] = await prisma.$transaction([
    prisma.ticket.update({ where: { id: ticket.id }, data: { assigneeId: parsed.data.assigneeId } }),
    prisma.ticketEntry.create({
      data: {
        ticketId: ticket.id,
        kind: TicketEntryKind.assignment_change,
        authorUserId: req.user.userId,
        body: noteBody,
      },
    }),
  ]);

  return res.json({ ticket: serializeTicket(updated) });
});

export default router;
