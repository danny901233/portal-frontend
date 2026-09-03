// Support hub Phase 1 — Mailgun inbound webhook.
//
// Receives emails sent to hello@receptionmate.co.uk (or any address on the
// Mailgun domain that has an inbound route pointed here). Converts every
// email into a Ticket (or threads to an existing one) and stores the body as
// a public_reply TicketEntry authored by the Contact.
//
// Threading precedence (most-reliable first):
//   1. Subject "[RM #123]" — our own outbound emails include this; guarantees
//      the reply lands on the correct ticket. Set on outbound send.
//   2. In-Reply-To header → TicketEntry.outboundMessageId lookup. Some clients
//      strip the [RM #N] token but preserve In-Reply-To — this catches those.
//   3. Neither matched → create a new Ticket.
//
// Auto-ack (Dan's rule 4): for a NEW email ticket, send a short acknowledgement
// email back so the customer knows we've got it. Log the ack as an `auto_ack`
// TicketEntry so it shows up on the timeline. Suppressed for threaded replies
// (they already know we're on it) and for spam-flagged contacts.
//
// Not yet in Phase 1:
//   - AI classification (category defaults to 'uncategorized' — Phase 1a)
//   - AI-drafted reply (public_reply with isDraft=true — Phase 1a)
//   - Noise/spam filter (Phase 1b)
//   - Email domain → Garage auto-linking (deferred per design doc)

import type { Request, Response } from 'express';
import { Router } from 'express';
import crypto from 'crypto';
import { Prisma, TicketChannel, TicketEntryKind, TicketStatus, TicketPriority } from '@prisma/client';
import { prisma } from '../../db.js';
import { sendEmail } from '../../utils/email.js';
import { enrichNewTicket } from '../../services/ticketAi.js';
import { classifyDeterministic } from '../../services/emailClassifier.js';

const router = Router();

// ─── Mailgun signature verification ─────────────────────────────────────────
// Mailgun signs every webhook with HMAC-SHA256(api_key, timestamp + token).
// We must verify or anyone on the internet can POST tickets into our system.

interface MailgunSignatureFields {
  timestamp: string;
  token: string;
  signature: string;
}

const verifyMailgunSignature = (fields: MailgunSignatureFields): boolean => {
  const apiKey = process.env.MAILGUN_API_KEY;
  if (!apiKey) {
    console.warn('[MAILGUN_INBOUND] MAILGUN_API_KEY not set — refusing to accept unverified webhooks');
    return false;
  }
  if (!fields.timestamp || !fields.token || !fields.signature) return false;

  // Replay-attack guard: reject anything older than 15 minutes.
  const nowSec = Math.floor(Date.now() / 1000);
  const tsSec = Number(fields.timestamp);
  if (!Number.isFinite(tsSec) || Math.abs(nowSec - tsSec) > 900) {
    console.warn(`[MAILGUN_INBOUND] Stale signature timestamp: ${fields.timestamp} (now=${nowSec})`);
    return false;
  }

  const expected = crypto
    .createHmac('sha256', apiKey)
    .update(fields.timestamp + fields.token)
    .digest('hex');

  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(fields.signature, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

// ─── Parsing helpers ────────────────────────────────────────────────────────

const RM_TICKET_TAG = /\[RM\s*#(\d+)\]/i;

const parseTicketNumberFromSubject = (subject: string | undefined): number | null => {
  if (!subject) return null;
  const m = RM_TICKET_TAG.exec(subject);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

// Extract the first bare email from an "In-Reply-To" or Message-Id header. Values look like
// "<20260826101337.eaa3d035cc337ad4@noreply.receptionmate.co.uk>" — the angle brackets
// and everything else are noise for our lookup.
const stripMessageId = (raw: string | undefined): string | null => {
  if (!raw) return null;
  const m = raw.match(/<([^>]+)>/);
  return (m ? m[1] : raw).trim() || null;
};

// Extract the sender address from Mailgun's `sender` (raw address) or `from`
// (display + address). Mailgun's `sender` is already clean, so prefer it.
const extractSenderEmail = (body: Record<string, unknown>): string | null => {
  const sender = typeof body.sender === 'string' ? body.sender.trim() : '';
  if (sender && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(sender)) return sender.toLowerCase();
  const from = typeof body.from === 'string' ? body.from : '';
  const m = from.match(/<([^>]+@[^>]+)>/) || from.match(/([^\s<>]+@[^\s<>]+)/);
  return m ? m[1].toLowerCase() : null;
};

const extractSenderName = (body: Record<string, unknown>): string | null => {
  const from = typeof body.from === 'string' ? body.from : '';
  const m = from.match(/^\s*"?([^"<]+?)"?\s*</);
  return m ? m[1].trim() : null;
};

// ─── No-reply sender guard (spec §5) ────────────────────────────────────────
// These senders never receive an auto-acknowledgement. Replying to a system
// mailbox loops (mailer-daemon) or damages sending reputation (no-reply
// aliases that discard). Regex matches the LOCAL PART of the address so
// noreply@anything, no-reply.foo@bar and support-noreply@baz all fire.
const NO_REPLY_LOCAL = /(^|[.\-_])(no[-_.]?reply|donot[-_.]?reply|mailer[-_.]?daemon|postmaster|bounce[s]?|notifications?)([.\-_]|$)/i;

const isNoReplySender = (email: string): boolean => {
  const local = email.split('@')[0] || '';
  if (NO_REPLY_LOCAL.test(local)) return true;
  // Full-address literals for special-case senders that don't match the
  // pattern (Google's mail-noreply@ variants are already covered).
  if (email === 'mailer-daemon@' || email.startsWith('mailer-daemon@')) return true;
  return false;
};

// ─── Contact upsert + identity linking (spec §3) ────────────────────────────
// On FIRST sight of a contact, try to link them to an existing portal User
// (exact email match) and, if that user has garage access, cache the first
// garage id onto the Contact so downstream ticket creation attaches to the
// right place. Users with multi-branch access get the first garage — staff
// can re-point via the admin UI. Nothing here fails the ingest if identity
// resolution comes up empty; unmatched senders still get a ticket.

async function getOrCreateContactByEmail(email: string, name: string | null) {
  const existing = await prisma.contact.findUnique({ where: { email } });
  if (existing) {
    // Fill in the name if we didn't have it before (some first messages arrive nameless).
    if (name && !existing.name) {
      return prisma.contact.update({ where: { id: existing.id }, data: { name } });
    }
    return existing;
  }

  // New contact — best-effort identity link.
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, garageAccessIds: true },
  });
  const linkedUserId = user?.id ?? null;
  const linkedGarageId =
    user && Array.isArray(user.garageAccessIds) && user.garageAccessIds.length > 0
      ? user.garageAccessIds[0]
      : null;

  if (linkedUserId) {
    console.log(
      `[MAILGUN_INBOUND] New contact ${email} linked to user ${linkedUserId}` +
      (linkedGarageId ? ` + garage ${linkedGarageId}` : ' (no garage access)'),
    );
  }

  return prisma.contact.create({
    data: {
      email,
      name,
      userId: linkedUserId,
      garageId: linkedGarageId,
    },
  });
}

// ─── Ticket threading ───────────────────────────────────────────────────────

async function resolveOrCreateTicket(args: {
  subject: string;
  contactId: string;
  garageId: string | null;
  inReplyTo: string | null;
}) {
  // 1. Subject tag wins — it's ours, deterministic, immune to header stripping.
  const num = parseTicketNumberFromSubject(args.subject);
  if (num !== null) {
    const t = await prisma.ticket.findUnique({ where: { number: num } });
    if (t) return { ticket: t, created: false as const };
  }

  // 2. In-Reply-To header → outboundMessageId lookup. Slower but catches replies
  //    from clients that ate our subject tag (unusual but happens).
  if (args.inReplyTo) {
    const entry = await prisma.ticketEntry.findFirst({
      where: { outboundMessageId: args.inReplyTo },
      select: { ticketId: true },
    });
    if (entry) {
      const t = await prisma.ticket.findUnique({ where: { id: entry.ticketId } });
      if (t) return { ticket: t, created: false as const };
    }
  }

  // 3. New ticket. Title = subject cleaned of the tag (or first 100 chars of body if no subject).
  const cleanTitle = (args.subject.replace(RM_TICKET_TAG, '').trim() || '(no subject)').slice(0, 300);
  const t = await prisma.ticket.create({
    data: {
      title: cleanTitle,
      channel: TicketChannel.email,
      contactId: args.contactId,
      garageId: args.garageId,
    },
  });
  return { ticket: t, created: true as const };
}

// ─── Auto-ack (rule 4: email YES) ───────────────────────────────────────────

async function sendAutoAck(args: {
  ticketNumber: number;
  ticketId: string;
  toEmail: string;
  contactName: string | null;
  originalSubject: string;
}) {
  const greet = args.contactName ? `Hi ${args.contactName.split(/\s+/)[0]},` : 'Hi,';
  const subjectTag = `[RM #${args.ticketNumber}]`;
  // If the original subject already had a tag we'd have threaded — no auto-ack fires. So
  // safe to always prepend fresh.
  const subject = `${subjectTag} ${args.originalSubject.replace(RM_TICKET_TAG, '').trim() || 'Your message'}`.slice(0, 300);

  const text = [
    greet,
    '',
    `Thanks for getting in touch — we've received your message and it's in our queue as ticket #${args.ticketNumber}.`,
    '',
    "The support team will be in touch shortly. When we reply, please keep the subject tag in place — that's how we thread your response back to the same conversation.",
    '',
    '— The ReceptionMate team',
  ].join('\n');

  const html = `<p>${greet.replace('<','&lt;')}</p>
<p>Thanks for getting in touch — we've received your message and it's in our queue as ticket #${args.ticketNumber}.</p>
<p>The support team will be in touch shortly. When we reply, please keep the subject tag in place — that's how we thread your response back to the same conversation.</p>
<p>— The ReceptionMate team</p>`;

  const ok = await sendEmail({
    to: [args.toEmail],
    subject,
    text,
    html,
  });
  if (!ok) {
    console.warn(`[MAILGUN_INBOUND] Auto-ack send failed for ticket #${args.ticketNumber}`);
    return;
  }

  // Log the auto-ack as a TicketEntry so it appears on the timeline. No authorUserId/authorContactId
  // (system-generated per the schema comment).
  await prisma.ticketEntry.create({
    data: {
      ticketId: args.ticketId,
      kind: TicketEntryKind.auto_ack,
      body: text,
    },
  });
  console.log(`[MAILGUN_INBOUND] Auto-ack sent + logged for ticket #${args.ticketNumber}`);
}

// ─── Route ──────────────────────────────────────────────────────────────────

router.post('/mailgun-inbound', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;

  // 1. Signature check — reject anything that isn't provably from Mailgun.
  //    Runs BEFORE audit persistence so we don't record garbage from random
  //    internet POSTs and give attackers a way to fill up our audit table.
  const sig: MailgunSignatureFields = {
    timestamp: String(body.timestamp ?? ''),
    token: String(body.token ?? ''),
    signature: String(body.signature ?? ''),
  };
  if (!verifyMailgunSignature(sig)) {
    console.warn('[MAILGUN_INBOUND] Rejected: bad or missing Mailgun signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // 2. AUDIT + DEDUP (spec §1.2 + §2 dedupe).
  //    Persist the raw payload BEFORE parsing anything, so a parser bug
  //    downstream never loses a customer's email. The @unique on messageId is
  //    the retry guard — Mailgun retries aggressively on non-200; a duplicate
  //    POST for the same message-id fails the insert and we drop it clean
  //    without ever touching the Ticket or TicketEntry tables.
  const inboundMessageId = stripMessageId(String(body['Message-Id'] ?? body['message-id'] ?? ''));

  let eventId: string;
  try {
    const ev = await prisma.mailgunInboundEvent.create({
      data: {
        messageId: inboundMessageId,
        rawPayload: body as Prisma.InputJsonValue,
        status: 'received',
      },
      select: { id: true },
    });
    eventId = ev.id;
  } catch (err) {
    // P2002 = unique constraint violation on messageId → this is a Mailgun
    // retry of a message we've already fully processed. Return 200 so Mailgun
    // stops retrying; do NOT create another ticket.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      console.log(`[MAILGUN_INBOUND] Dropped duplicate (message-id already seen): ${inboundMessageId}`);
      return res.status(200).json({ status: 'dropped_dupe' });
    }
    // Any other insert error → 500 so Mailgun retries. Losing a customer email
    // is worse than a duplicate ticket (dedup can happen; loss is silent).
    console.error('[MAILGUN_INBOUND] Failed to persist inbound event:', err);
    return res.status(500).json({ error: 'Internal error' });
  }

  // Small helper to mark the event terminal state for later audit. Never throws
  // — audit failures shouldn't tank the response.
  const finalizeEvent = async (status: string, ticketId: string | null) => {
    try {
      await prisma.mailgunInboundEvent.update({
        where: { id: eventId },
        data: { status, ticketId },
      });
    } catch (auditErr) {
      console.error('[MAILGUN_INBOUND] audit finalize failed:', auditErr);
    }
  };

  try {
    // 3. Sender resolution — email is the identity anchor.
    const email = extractSenderEmail(body);
    if (!email) {
      console.warn('[MAILGUN_INBOUND] Rejected: no parseable sender email');
      void finalizeEvent('dropped_empty', null);
      return res.status(400).json({ error: 'No sender email' });
    }
    const senderName = extractSenderName(body);

    const subject = String(body.subject ?? '').trim();
    // Prefer stripped-text (quotes removed) so threading doesn't duplicate the prior reply chain.
    const bodyText = String(body['stripped-text'] ?? body['body-plain'] ?? '').trim();
    if (!bodyText) {
      console.warn(`[MAILGUN_INBOUND] Rejected: empty body from ${email} subject=${JSON.stringify(subject)}`);
      void finalizeEvent('dropped_empty', null);
      return res.status(400).json({ error: 'Empty body' });
    }

    const inReplyTo = stripMessageId(String(body['In-Reply-To'] ?? body['in-reply-to'] ?? ''));
    const noReplySender = isNoReplySender(email);

    // 4. Contact upsert + block check.
    const contact = await getOrCreateContactByEmail(email, senderName);
    if (contact.blocked) {
      console.log(`[MAILGUN_INBOUND] Dropped blocked contact ${email}`);
      void finalizeEvent('dropped_blocked', null);
      return res.status(200).json({ status: 'dropped_blocked' });
    }

    // 5. Ticket threading (or create).
    const { ticket, created } = await resolveOrCreateTicket({
      subject,
      contactId: contact.id,
      garageId: contact.garageId,
      inReplyTo,
    });

    // 6. Log the inbound email as a public_reply from the contact.
    //    outboundMessageId is DELIBERATELY left null — that field is for OUR
    //    outbound Message-Id (so future customer replies can thread back to
    //    our sent messages via In-Reply-To). Storing the customer's inbound
    //    Message-Id here would pollute that index. Dedup + audit live on
    //    MailgunInboundEvent instead.
    await prisma.ticketEntry.create({
      data: {
        ticketId: ticket.id,
        kind: TicketEntryKind.public_reply,
        authorContactId: contact.id,
        body: bodyText,
        // meta carries the original headers we might need later — Message-Id
        // for future In-Reply-To lookups when staff reply (spec §7), plus the
        // In-Reply-To the customer's client sent so we can build a proper
        // References chain on our reply.
        meta: {
          inboundMessageId,
          inReplyTo,
        } as Prisma.InputJsonValue,
      },
    });

    // 7. Bump lastCustomerActivityAt. If ticket had been solved, reopen it — a
    //    customer reply on a "solved" ticket is a signal we didn't actually solve it.
    const patch: Prisma.TicketUpdateInput = { lastCustomerActivityAt: new Date() };
    if (ticket.status === TicketStatus.solved || ticket.status === TicketStatus.closed) {
      patch.status = TicketStatus.open;
      patch.solvedAt = null;
      patch.closedAt = null;
    }
    await prisma.ticket.update({ where: { id: ticket.id }, data: patch });

    // 8. Deterministic classification (spec §4): supplier domains + complaint
    //    keywords go through hand-rolled rules FIRST. Only what remains falls
    //    through to the AI classifier in enrichNewTicket.
    let deterministicHit = false;
    if (created) {
      const det = classifyDeterministic({
        senderEmail: email,
        subject,
        bodyText,
        contactGarageId: contact.garageId,
      });
      if (det) {
        deterministicHit = true;
        try {
          // Resolve the assignee email to a userId at write time — we don't
          // want a hardcoded id in the classifier config.
          let assigneeId: string | null | undefined = undefined;
          if (det.assigneeEmail) {
            const staff = await prisma.user.findUnique({
              where: { email: det.assigneeEmail.toLowerCase() },
              select: { id: true },
            });
            assigneeId = staff?.id ?? null;
          }
          await prisma.ticket.update({
            where: { id: ticket.id },
            data: {
              category: det.category,
              ...(det.priority ? { priority: det.priority } : {}),
              ...(assigneeId !== undefined ? { assigneeId } : {}),
            },
          });
          console.log(
            `[MAILGUN_INBOUND] Deterministic rule "${det.rule}" matched ticket #${ticket.number}` +
            ` → category=${det.category}` +
            (det.priority ? ` priority=${det.priority}` : '') +
            (det.assigneeEmail ? ` assignee=${det.assigneeEmail}` : ''),
          );
        } catch (detErr) {
          // Rule application failures should not block the pipeline — the
          // ticket exists, staff can classify manually.
          console.error(`[MAILGUN_INBOUND] Deterministic rule apply failed for #${ticket.number}:`, detErr);
          deterministicHit = false; // let the AI have another go
        }
      }
    }

    // 9. Respond 200 to Mailgun BEFORE firing side effects. Two reasons:
    //    (a) LLM enrichment + auto-ack send can each take 1-5s; Mailgun will
    //        retry if we take too long, causing duplicate tickets on the retry.
    //    (b) The essentials (ticket + entry + timestamps) are already committed
    //        above — the customer's email is safely stored. Auto-ack and AI draft
    //        are enhancements, not correctness-critical.
    console.log(`[MAILGUN_INBOUND] ${created ? 'Created' : 'Threaded to'} ticket #${ticket.number} from ${email}`);
    void finalizeEvent(created ? 'created' : 'threaded', ticket.id);
    res.status(200).json({ status: 'ok', ticketNumber: ticket.number, created });

    // 10. Fire-and-forget: auto-ack for new tickets (spec §5).
    //     Suppressed for no-reply senders — replying to mailer-daemon /
    //     noreply@ addresses either loops or damages our sending reputation.
    if (created && !noReplySender) {
      void sendAutoAck({
        ticketNumber: ticket.number,
        ticketId: ticket.id,
        toEmail: email,
        contactName: contact.name,
        originalSubject: subject,
      }).catch((err) => console.error('[MAILGUN_INBOUND] auto-ack error:', err));
    } else if (created && noReplySender) {
      console.log(`[MAILGUN_INBOUND] Skipping auto-ack for no-reply sender ${email} (ticket #${ticket.number})`);
    }

    // 11. Fire-and-forget: AI classification + draft reply on new tickets only.
    //     Skip on threaded replies — the ticket is already categorized and a
    //     fresh AI draft on every reply would spam the staff UI. Skip AI
    //     classification if a deterministic rule already fired — the draft
    //     still runs (rules don't produce a suggested reply).
    if (created) {
      void enrichNewTicket({
        ticketId: ticket.id,
        ticketNumber: ticket.number,
        subject,
        body: bodyText,
        contactName: contact.name,
        skipClassification: deterministicHit,
      }).catch((err) => console.error('[MAILGUN_INBOUND] AI enrichment error:', err));
    }
    return;
  } catch (err) {
    // Log + 500 so Mailgun retries. We WANT Mailgun to retry — losing a customer
    // email is worse than a duplicate ticket (dedup can happen; loss is silent).
    console.error('[MAILGUN_INBOUND] Handler error:', err);
    void finalizeEvent('failed', null);
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Internal error' });
    }
    return;
  }
});

export default router;
