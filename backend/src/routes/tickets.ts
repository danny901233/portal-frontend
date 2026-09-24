// Support hub Phase 2 continuation — ticket-model routes.
// Reads/writes the Ticket / Contact / TicketEntry tables added in PR #381.
//
// Staff-only. All endpoints go through requireAdmin.
//
// Endpoints:
//   GET    /api/admin/tickets                — list with filters (status, assignee, channel, category, garageId)
//   GET    /api/admin/tickets/queue-counts   — sidebar counts (unassigned, mine open, pending 3+ days)
//   GET    /api/admin/tickets/:id            — one ticket + all entries in chronological order
//   POST   /api/admin/tickets                — create a ticket (for seeding + testing; production ingest is Phase 1/3/4)
//   POST   /api/admin/tickets/:id/reply      — post a public_reply (sends to customer once channel-send is wired up)
//   POST   /api/admin/tickets/:id/note       — post an internal_note (staff-only, never sent out)
//   PATCH  /api/admin/tickets/:id/status     — status transition + logs a status_change entry
//   PATCH  /api/admin/tickets/:id/assign     — assignment change + logs an assignment_change entry
//
// Not in this file:
//   - Actual outbound sending (email/whatsapp) — wired in Phase 1 / Phase 3
//   - AI classification of category on ingest — wired in Phase 1
//   - Contact merge / re-linking — deferred (per PR #381 doc)

import type { Request, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { Prisma, TicketStatus, TicketCategory, TicketPriority, TicketChannel, TicketEntryKind } from '@prisma/client';
import { prisma } from '../db.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { sendEmail, SUPPORT_MAILGUN_DOMAIN } from '../utils/email.js';
import { ticketSubjectTag, stripTicketTag, ticketNumberCandidates } from '../services/ticketRef.js';
import { verifyPushReplyToken } from '../services/pushReplyToken.js';

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
const statusEnum   = z.enum(['new', 'open', 'pending', 'on_hold', 'solved', 'closed'])
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

const replySchema = z.object({
  body: z.string().trim().min(1).max(20000),
  isDraft: z.boolean().optional(),  // AI-drafted, not yet approved (default false = staff typed & sent)
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
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

  const [unassigned, mineOpen, pendingStale] = await Promise.all([
    prisma.ticket.count({ where: { assigneeId: null, status: { in: [TicketStatus.new_, TicketStatus.open] } } }),
    prisma.ticket.count({ where: { assigneeId: req.user.userId, status: TicketStatus.open } }),
    prisma.ticket.count({ where: { status: TicketStatus.pending, lastCustomerActivityAt: { lt: threeDaysAgo } } }),
  ]);

  return res.json({ unassigned, mineOpen, pendingStale });
});

// ─── DETAIL ────────────────────────────────────────────────────────────────

router.get('/admin/tickets/:id', authenticate, requireAdmin, async (req: Request, res: Response) => {
  const ticket = await prisma.ticket.findUnique({
    where: { id: req.params.id },
    include: {
      contact:  { select: { id: true, email: true, phone: true, name: true, garageId: true } },
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

// ─── REPLY (public — customer-facing) ──────────────────────────────────────

// ─── Outbound Message-Id + threading helpers (spec §7) ─────────────────────
// A stored, deterministic Message-Id lets a customer's reply come back with
// In-Reply-To pointing at us — the inbound webhook then threads it to the
// correct ticket by looking up TicketEntry.outboundMessageId. Format follows
// RFC5322: <local@domain>, angle brackets included when sent as a header.

const OUTBOUND_MSGID_DOMAIN = process.env.MAILGUN_DOMAIN || 'receptionmate.co.uk';

/**
 * Who a ticket reply comes FROM.
 *
 * Without this the send falls through to MAILGUN_FROM, which is
 * `noreply@receptionmate.co.uk` — a subdomain whose MX records point at a
 * Mailgun region the account does not use, so nothing sent there can ever be
 * received. The customer's reply would bounce and the thread this code builds
 * `In-Reply-To` for would silently dead-end.
 *
 * Replying as `hello@` is also what closes the loop: that address is on
 * Microsoft 365, whose rule copies it back to Mailgun's inbound webhook, so the
 * customer's reply threads onto this same ticket. It is the address they already
 * write to, and the only one every outbound template tells them to use.
 */
const SUPPORT_FROM = process.env.SUPPORT_FROM_EMAIL || 'hello@receptionmate.co.uk';

const generateOutboundMessageId = (ticketNumber: number): string => {
  // <ticket-{number}.{random}.{ts}@domain>. Ticket number in the id itself
  // is belt-and-braces if the DB row ever gets corrupted; random suffix
  // guarantees uniqueness within the second.
  const rand = randomBytes(6).toString('hex');
  const ts = Date.now();
  return `<rm-t${ticketNumber}.${ts}.${rand}@${OUTBOUND_MSGID_DOMAIN}>`;
};

// Build In-Reply-To + References from the latest inbound entry on this ticket,
// so our outbound message lands in the customer's original email thread.
// References follows RFC 5322 §3.6.4: chain the previous References + the
// message being replied to.
async function buildThreadingHeaders(
  ticketId: string,
  outboundMessageId: string,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    'Message-Id': outboundMessageId,
  };

  // Most-recent inbound entry that carries an inbound Message-Id in its meta.
  // (Only inbound entries have `meta.inboundMessageId`; outbound entries have
  // their own id on `outboundMessageId`.)
  const lastInbound = await prisma.ticketEntry.findFirst({
    where: {
      ticketId,
      authorContactId: { not: null },
      kind: TicketEntryKind.public_reply,
    },
    orderBy: { createdAt: 'desc' },
    select: { meta: true },
  });

  const inboundMeta =
    lastInbound?.meta && typeof lastInbound.meta === 'object' && !Array.isArray(lastInbound.meta)
      ? (lastInbound.meta as Record<string, unknown>)
      : null;
  const lastInboundMsgId =
    inboundMeta && typeof inboundMeta.inboundMessageId === 'string' && inboundMeta.inboundMessageId
      ? inboundMeta.inboundMessageId
      : null;
  const lastInboundInReplyTo =
    inboundMeta && typeof inboundMeta.inReplyTo === 'string' && inboundMeta.inReplyTo
      ? inboundMeta.inReplyTo
      : null;

  if (lastInboundMsgId) {
    const bracketed = lastInboundMsgId.startsWith('<') ? lastInboundMsgId : `<${lastInboundMsgId}>`;
    headers['In-Reply-To'] = bracketed;
    // References = customer's earlier References chain (if any) + the id we're
    // replying to. Minimal but valid: just the id we're replying to.
    const prior = lastInboundInReplyTo
      ? (lastInboundInReplyTo.startsWith('<') ? lastInboundInReplyTo : `<${lastInboundInReplyTo}>`)
      : '';
    headers.References = [prior, bracketed].filter(Boolean).join(' ');
  }

  return headers;
}

// Convert plain-text staff reply into a minimal HTML body — one <p> per
// paragraph, line breaks preserved. Keeps outbound emails readable in HTML
// clients without any of us writing raw HTML.
const textToHtml = (text: string): string => {
  const escape = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const paragraphs = text.split(/\n{2,}/).map((p) => `<p>${escape(p).replace(/\n/g, '<br>')}</p>`);
  return paragraphs.join('\n');
};

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
}): Promise<{ status: number; entry?: unknown; error?: string }> {
  const ticket = await prisma.ticket.findUnique({
    where: { id: args.ticketId },
    include: { contact: { select: { id: true, email: true, name: true } } },
  });
  if (!ticket) return { status: 404, error: 'Ticket not found' };

  const now = new Date();

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

  const outboundMessageId = generateOutboundMessageId(ticket.number);
  const threadingHeaders = await buildThreadingHeaders(ticket.id, outboundMessageId);

  // Subject always carries the reference so a customer reply threads back via the
  // subject-tag rule in mailgun-inbound. Strip any prior tag from the title so we
  // do not double up.
  const cleanTitle = stripTicketTag(ticket.title) || 'Your ticket';
  const subject = `${ticketSubjectTag(ticket.number)} ${cleanTitle}`.slice(0, 300);

  const sendOk = await sendEmail({
    to: [ticket.contact.email as string],
    from: SUPPORT_FROM,
    // Through the support domain, so the return path never reads "noreply".
    domain: SUPPORT_MAILGUN_DOMAIN,
    subject,
    text: args.body,
    html: textToHtml(args.body),
    headers: threadingHeaders,
  });

  const sendMeta: Record<string, unknown> = {
    outboundMessageId,
    threadingHeaders,
    sentBy: args.userEmail,
    sentAt: now.toISOString(),
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

  await prisma.ticket.update({
    where: { id: ticket.id },
    data: {
      lastStaffActivityAt: now,
      firstResponseAt: ticket.firstResponseAt ?? now,
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
  });

  return res.status(result.status).json(
    result.error ? { entry: result.entry, error: result.error } : { entry: result.entry },
  );
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
  if (parsed.data.status === TicketStatus.solved) patch.solvedAt = now;
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
