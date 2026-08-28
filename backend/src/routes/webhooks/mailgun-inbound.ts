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
import { Prisma, TicketChannel, TicketEntryKind, TicketStatus } from '@prisma/client';
import { prisma } from '../../db.js';
import { sendEmail } from '../../utils/email.js';
import { enrichNewTicket } from '../../services/ticketAi.js';

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

// ─── Contact upsert ─────────────────────────────────────────────────────────

async function getOrCreateContactByEmail(email: string, name: string | null) {
  const existing = await prisma.contact.findUnique({ where: { email } });
  if (existing) {
    // Fill in the name if we didn't have it before (some first messages arrive nameless).
    if (name && !existing.name) {
      return prisma.contact.update({ where: { id: existing.id }, data: { name } });
    }
    return existing;
  }
  return prisma.contact.create({ data: { email, name } });
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
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;

    // 1. Signature check — reject anything that isn't provably from Mailgun.
    const sig: MailgunSignatureFields = {
      timestamp: String(body.timestamp ?? ''),
      token: String(body.token ?? ''),
      signature: String(body.signature ?? ''),
    };
    if (!verifyMailgunSignature(sig)) {
      console.warn('[MAILGUN_INBOUND] Rejected: bad or missing Mailgun signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // 2. Sender resolution — email is the identity anchor.
    const email = extractSenderEmail(body);
    if (!email) {
      console.warn('[MAILGUN_INBOUND] Rejected: no parseable sender email');
      return res.status(400).json({ error: 'No sender email' });
    }
    const senderName = extractSenderName(body);

    const subject = String(body.subject ?? '').trim();
    // Prefer stripped-text (quotes removed) so threading doesn't duplicate the prior reply chain.
    const bodyText = String(body['stripped-text'] ?? body['body-plain'] ?? '').trim();
    if (!bodyText) {
      console.warn(`[MAILGUN_INBOUND] Rejected: empty body from ${email} subject=${JSON.stringify(subject)}`);
      return res.status(400).json({ error: 'Empty body' });
    }

    const inReplyTo = stripMessageId(String(body['In-Reply-To'] ?? body['in-reply-to'] ?? ''));
    const messageId = stripMessageId(String(body['Message-Id'] ?? body['message-id'] ?? ''));

    // 3. Contact upsert + block check.
    const contact = await getOrCreateContactByEmail(email, senderName);
    if (contact.blocked) {
      console.log(`[MAILGUN_INBOUND] Dropped blocked contact ${email}`);
      return res.status(200).json({ status: 'dropped_blocked' });
    }

    // 4. Ticket threading (or create).
    const { ticket, created } = await resolveOrCreateTicket({
      subject,
      contactId: contact.id,
      garageId: contact.garageId,
      inReplyTo,
    });

    // 5. Log the inbound email as a public_reply from the contact.
    await prisma.ticketEntry.create({
      data: {
        ticketId: ticket.id,
        kind: TicketEntryKind.public_reply,
        authorContactId: contact.id,
        body: bodyText,
        outboundMessageId: messageId,  // stored so future replies can thread back
      },
    });

    // 6. Bump lastCustomerActivityAt. If ticket had been solved, reopen it — a
    //    customer reply on a "solved" ticket is a signal we didn't actually solve it.
    const patch: Prisma.TicketUpdateInput = { lastCustomerActivityAt: new Date() };
    if (ticket.status === TicketStatus.solved || ticket.status === TicketStatus.closed) {
      patch.status = TicketStatus.open;
      patch.solvedAt = null;
      patch.closedAt = null;
    }
    await prisma.ticket.update({ where: { id: ticket.id }, data: patch });

    // 7. Respond 200 to Mailgun BEFORE firing side effects. Two reasons:
    //    (a) LLM enrichment + auto-ack send can each take 1-5s; Mailgun will
    //        retry if we take too long, causing duplicate tickets on the retry.
    //    (b) The essentials (ticket + entry + timestamps) are already committed
    //        above — the customer's email is safely stored. Auto-ack and AI draft
    //        are enhancements, not correctness-critical.
    console.log(`[MAILGUN_INBOUND] ${created ? 'Created' : 'Threaded to'} ticket #${ticket.number} from ${email}`);
    res.status(200).json({ status: 'ok', ticketNumber: ticket.number, created });

    // Fire-and-forget: auto-ack for new tickets (rule 4: email YES).
    if (created) {
      void sendAutoAck({
        ticketNumber: ticket.number,
        ticketId: ticket.id,
        toEmail: email,
        contactName: contact.name,
        originalSubject: subject,
      }).catch((err) => console.error('[MAILGUN_INBOUND] auto-ack error:', err));
    }

    // Fire-and-forget: AI classification + draft reply on new tickets only.
    // Skip on threaded replies — the ticket is already categorized and a fresh
    // AI draft on every reply would spam the staff UI. (Future: consider re-draft
    // if staff explicitly requests it.)
    if (created) {
      void enrichNewTicket({
        ticketId: ticket.id,
        ticketNumber: ticket.number,
        subject,
        body: bodyText,
        contactName: contact.name,
      }).catch((err) => console.error('[MAILGUN_INBOUND] AI enrichment error:', err));
    }
    return;
  } catch (err) {
    // Log + 500 so Mailgun retries. We WANT Mailgun to retry — losing a customer
    // email is worse than a duplicate ticket (dedup can happen; loss is silent).
    console.error('[MAILGUN_INBOUND] Handler error:', err);
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Internal error' });
    }
    return;
  }
});

export default router;
