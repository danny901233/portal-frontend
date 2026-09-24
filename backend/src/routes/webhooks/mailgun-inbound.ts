// Support hub Phase 1 — Mailgun inbound webhook.
//
// Receives emails sent to hello@receptionmate.co.uk (or any address on the
// Mailgun domain that has an inbound route pointed here). Converts every
// email into a Ticket (or threads to an existing one) and stores the body as
// a public_reply TicketEntry authored by the Contact.
//
// Threading precedence (most-reliable first):
//   1. Subject "[RM-XXXXXXX]" — our own outbound emails include this; guarantees
//      the reply lands on the correct ticket. Set on outbound send. The code is
//      an obfuscated ticket number (services/ticketRef.ts), because a sequential
//      "[RM #4]" tells the customer how many support emails we have ever had.
//   2. In-Reply-To header → TicketEntry.outboundMessageId lookup. Some clients
//      strip the subject tag but preserve In-Reply-To — this catches those.
//   3. Neither matched → create a new Ticket.
//
// Auto-ack (Dan's rule 4): for a NEW email ticket, send a short acknowledgement
// email back so the customer knows we've got it. Log the ack as an `auto_ack`
// TicketEntry so it shows up on the timeline. Suppressed for threaded replies
// (they already know we're on it) and for spam-flagged contacts.
//
// Spam: bulk-mail headers and automated senders are settled by rules
// (services/emailClassifier.ts) and filed closed on arrival; cold outreach
// written by a person is left to the AI classifier, whose verdict withholds the
// acknowledgement and the staff push. Staff can also mark a ticket as spam,
// which blocks the sender — blocked contacts are dropped at step 4 below.
//
// Not yet in Phase 1:
//   - Email domain → Garage auto-linking (deferred per design doc)

import type { Request, Response } from 'express';
import { Router } from 'express';
import crypto from 'crypto';
import { Prisma, TicketChannel, TicketEntryKind, TicketStatus, TicketPriority } from '@prisma/client';
import { prisma } from '../../db.js';
import { sendEmail, SUPPORT_MAILGUN_DOMAIN } from '../../utils/email.js';
import { enrichNewTicket } from '../../services/ticketAi.js';
import { classifyDeterministic, isNoReplySender, parseMailgunHeaders } from '../../services/emailClassifier.js';
import { ticketSubjectTag, ticketNumberFromSubject, stripTicketTag } from '../../services/ticketRef.js';
import { pushNewTicketToStaff } from '../../services/ticketPush.js';

const router = Router();

// ─── Mailgun signature verification ─────────────────────────────────────────
// Mailgun signs every webhook with HMAC-SHA256(key, timestamp + token).
// We must verify or anyone on the internet can POST tickets into our system.
//
// The key is the account's HTTP WEBHOOK SIGNING KEY, not the API key — the same
// one routes/webhooks/mailgun.ts already uses for delivery events. Verified the
// hard way on 2026-09-23: signing with MAILGUN_API_KEY rejected a real
// route-forwarded message as "bad or missing Mailgun signature". That failure is
// invisible in the data — the check runs before anything is written, so a
// rejected email leaves no MailgunInboundEvent row and looks exactly like mail
// that never arrived.
//
// MAILGUN_API_KEY stays as a fallback only so an environment that has not had
// the signing key added yet keeps working rather than silently dropping mail.

interface MailgunSignatureFields {
  timestamp: string;
  token: string;
  signature: string;
}

const verifyMailgunSignature = (fields: MailgunSignatureFields): boolean => {
  const apiKey = process.env.MAILGUN_WEBHOOK_SIGNING_KEY || process.env.MAILGUN_API_KEY;
  if (!apiKey) {
    console.warn('[MAILGUN_INBOUND] No MAILGUN_WEBHOOK_SIGNING_KEY or MAILGUN_API_KEY set — refusing to accept unverified webhooks');
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

// Tag parsing lives in services/ticketRef.ts so the inbound matcher and the
// outbound subject line cannot drift apart.

const parseTicketNumberFromSubject = (subject: string | undefined): number | null =>
  subject ? ticketNumberFromSubject(subject) : null;

// Extract the first bare email from an "In-Reply-To" or Message-Id header. Values look like
// "<20260826101337.eaa3d035cc337ad4@noreply.receptionmate.co.uk>" — the angle brackets
// and everything else are noise for our lookup.
const stripMessageId = (raw: string | undefined): string | null => {
  if (!raw) return null;
  const m = raw.match(/<([^>]+)>/);
  return (m ? m[1] : raw).trim() || null;
};

/**
 * Who actually wrote the email.
 *
 * The `From` HEADER, not Mailgun's `sender`. `sender` is the SMTP envelope
 * sender, which is whoever handed us the message rather than whoever composed
 * it, and it gets rewritten in transit. A live test produced:
 *
 *   sender : bounce+ae18a6.57875-inbound=support...@noreply.receptionmate.co.uk
 *   from   : Test Customer <noreply@receptionmate.co.uk>
 *
 * That matters here more than usual, because mail reaches us forwarded from
 * Microsoft 365 rather than delivered directly. Forwarding commonly rewrites
 * the envelope sender (SRS) to the forwarding mailbox, so trusting it would
 * file every ticket against one Contact — the forwarder — and send replies
 * there instead of to the customer.
 *
 * Falls back to the envelope only when there is no usable From header.
 */
const extractSenderEmail = (body: Record<string, unknown>): string | null => {
  const from = typeof body.from === 'string' ? body.from : '';
  const m = from.match(/<([^>]+@[^>]+)>/) || from.match(/([^\s<>]+@[^\s<>]+)/);
  if (m) return m[1].toLowerCase();

  const sender = typeof body.sender === 'string' ? body.sender.trim() : '';
  if (sender && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(sender)) return sender.toLowerCase();
  return null;
};

const extractSenderName = (body: Record<string, unknown>): string | null => {
  const from = typeof body.from === 'string' ? body.from : '';
  const m = from.match(/^\s*"?([^"<]+?)"?\s*</);
  return m ? m[1].trim() : null;
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
  const cleanTitle = (stripTicketTag(args.subject) || '(no subject)').slice(0, 300);
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

/** How long the acknowledgement waits for the classifier's spam verdict. Past
 *  this it goes out regardless — a customer left unanswered because OpenAI was
 *  slow is worse than one cold-caller learning the inbox is read. */
const ACK_CLASSIFIER_WAIT_MS = 15_000;

const withDeadline = <T,>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      () => { clearTimeout(timer); resolve(fallback); },
    );
  });

async function sendAutoAck(args: {
  ticketNumber: number;
  ticketId: string;
  toEmail: string;
  contactName: string | null;
  originalSubject: string;
}) {
  const greet = args.contactName ? `Hi ${args.contactName.split(/\s+/)[0]},` : 'Hi,';
  const subjectTag = ticketSubjectTag(args.ticketNumber);
  // If the original subject already had a tag we'd have threaded — no auto-ack fires. So
  // safe to always prepend fresh.
  const subject = `${subjectTag} ${stripTicketTag(args.originalSubject) || 'Your message'}`.slice(0, 300);

  // Deliberately says nothing about tickets or queues. "Raised a ticket for it"
  // and "it's in our queue" are true, but they tell a customer they have joined a
  // line — which is the opposite of the impression we want from the first thing
  // we ever send them automatically. This reads as though a person has it.
  // The reference is for the customer to quote back, so it goes in the body as
  // well as the subject. It is the obfuscated code, never ticket.number: they
  // need something to refer to, not their position in a queue.
  const reference = subjectTag.replace(/[\[\]]/g, '');

  const text = [
    greet,
    '',
    "Thanks for getting in touch — your message has come through to our team and we're on it.",
    '',
    `Your reference is ${reference}, if you ever need to quote it.`,
    '',
    "We'll come back to you shortly. If you think of anything else in the meantime, just reply to this email and it'll reach the same person.",
    '',
    '— The ReceptionMate team',
  ].join('\n');

  const html = `<p>${greet.replace('<','&lt;')}</p>
<p>Thanks for getting in touch — your message has come through to our team and we're on it.</p>
<p>Your reference is <strong>${reference}</strong>, if you ever need to quote it.</p>
<p>We'll come back to you shortly. If you think of anything else in the meantime, just reply to this email and it'll reach the same person.</p>
<p>— The ReceptionMate team</p>`;

  const ok = await sendEmail({
    // Same reason as the reply path in routes/tickets.ts: the default
    // MAILGUN_FROM is noreply@, which cannot receive, and this message invites
    // a reply. Send as the address the customer already wrote to.
    from: process.env.SUPPORT_FROM_EMAIL || 'hello@receptionmate.co.uk',
    // Through the support domain: this message invites a reply, so its return
    // path must not read "noreply".
    domain: SUPPORT_MAILGUN_DOMAIN,
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
    // A rule can say "this is not a conversation" — supplier billing, receipts —
    // in which case we neither acknowledge it nor pay to draft a reply to it.
    let ruleAllowsAutoAck = true;
    let ruleAllowsAiDraft = true;
    // Filed-on-arrival mail (receipts, our own lead notifications) is not work,
    // so it must not buzz anyone's phone either.
    let ruleAutoClosed = false;
    if (created) {
      const det = classifyDeterministic({
        senderEmail: email,
        subject,
        bodyText,
        contactGarageId: contact.garageId,
        headers: parseMailgunHeaders(body['message-headers']),
      });
      if (det) {
        deterministicHit = true;
        ruleAllowsAutoAck = det.autoAck !== false;
        ruleAllowsAiDraft = det.aiDraft !== false;
        ruleAutoClosed = det.autoClose === true;
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
              // A receipt is a record, not work: keep it for the audit trail and
              // close it on the way in so it never reaches a queue.
              ...(det.autoClose ? { status: TicketStatus.closed, closedAt: new Date() } : {}),
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
          ruleAllowsAutoAck = true;
          ruleAllowsAiDraft = true;
          ruleAutoClosed = false;
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

    // 10. Fire-and-forget: AI classification + draft reply on new tickets only.
    //     Skip on threaded replies — the ticket is already categorized and a
    //     fresh AI draft on every reply would spam the staff UI. Skip AI
    //     classification if a deterministic rule already fired — the draft
    //     still runs (rules don't produce a suggested reply).
    //
    //     Its verdict also gates the acknowledgement below: a cold pitch that
    //     slipped past the header rules must not get a reply confirming the
    //     address is read.
    let enrichment: Promise<{ spam: boolean }> = Promise.resolve({ spam: false });
    if (created && ruleAllowsAiDraft) {
      enrichment = enrichNewTicket({
        ticketId: ticket.id,
        ticketNumber: ticket.number,
        subject,
        body: bodyText,
        contactName: contact.name,
        // Needed to mirror a sales enquiry into HighLevel.
        contactEmail: email,
        skipClassification: deterministicHit,
      }).catch((err) => {
        console.error('[MAILGUN_INBOUND] AI enrichment error:', err);
        return { spam: false };
      });
    }

    // 10b. Fire-and-forget: tell the team a ticket has arrived.
    //      New tickets only — a reply onto an open ticket is already somebody's,
    //      and a phone buzzing for both halves of a conversation is noise. Never
    //      for mail a rule filed on arrival. The push waits for the AI draft and
    //      re-checks the ticket before sending, so one the classifier files as
    //      spam in the meantime goes silent too.
    if (created && !ruleAutoClosed) {
      void pushNewTicketToStaff(ticket.id);
    }

    // 11. Fire-and-forget: auto-ack for new tickets (spec §5), once the
    //     classifier has had its say. Bounded wait — a slow OpenAI call may
    //     delay the acknowledgement, never lose it.
    //     Suppressed for no-reply senders — replying to mailer-daemon /
    //     noreply@ addresses either loops or damages our sending reputation.
    if (created && !noReplySender && ruleAllowsAutoAck) {
      void withDeadline(enrichment, ACK_CLASSIFIER_WAIT_MS, { spam: false })
        .then((verdict) => {
          if (verdict.spam) {
            console.log(`[MAILGUN_INBOUND] Skipping auto-ack — classifier filed ticket #${ticket.number} as spam`);
            return;
          }
          return sendAutoAck({
            ticketNumber: ticket.number,
            ticketId: ticket.id,
            toEmail: email,
            contactName: contact.name,
            originalSubject: subject,
          });
        })
        .catch((err) => console.error('[MAILGUN_INBOUND] auto-ack error:', err));
    } else if (created && noReplySender) {
      console.log(`[MAILGUN_INBOUND] Skipping auto-ack for no-reply sender ${email} (ticket #${ticket.number})`);
    } else if (created && !ruleAllowsAutoAck) {
      console.log(`[MAILGUN_INBOUND] Skipping auto-ack — a rule marked ticket #${ticket.number} as not a conversation`);
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
