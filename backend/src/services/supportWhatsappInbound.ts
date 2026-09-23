// Support hub Phase 3 — WhatsApp inbound.
//
// Called by the Meta WhatsApp webhook when a message arrives to the RM support
// WhatsApp number (env: SUPPORT_WHATSAPP_PHONE_NUMBER_ID). Different from the
// existing meta-whatsapp handler which routes to a garage's ChatConversation —
// this one routes to a Support Ticket.
//
// Threading (Phase 3 chose "one open ticket per Contact phone"):
//   - WhatsApp payloads carry no subject line and no In-Reply-To equivalent, so
//     the RM #N-in-subject trick from Phase 1 doesn't apply.
//   - Instead: find the Contact's most recent OPEN-family ticket (new/open/
//     pending/on_hold). If one exists, append to it. If not, create a new one.
//   - A message on a solved/closed ticket does NOT reopen that ticket — a fresh
//     interaction from a customer after we said "solved" is a new conversation,
//     not a re-hash of the old one. (Different from email where subject-tag
//     forces threading and staff would want reopen semantics.)
//
// Auto-ack (rule 4: whatsapp YES-if-24h):
//   - Fires only on NEW ticket creation (not appends).
//   - Inbound message resets Meta's 24h reply window, so an immediate outbound
//     is always in-window — no template message needed.
//
// AI enrichment: reuses the same enrichNewTicket helper as Phase 1 (email).

import axios from 'axios';
import { TicketChannel, TicketEntryKind, TicketStatus } from '@prisma/client';
import { prisma } from '../db.js';
import { enrichNewTicket } from './ticketAi.js';

export interface SupportWhatsappInput {
  fromPhone: string;          // customer's WhatsApp id (typically E.164 without leading +)
  senderName: string | null;  // Meta profile.name
  bodyText: string;
  messageId: string | null;   // Meta wa_id — stored for future threading of our own outbound
  supportPhoneNumberId: string;
  supportAccessToken: string;
}

// Normalise to E.164 with a leading +. Meta sends numbers without + (e.g.
// "447528439272"). We store with + to match everything else in the schema.
const normalizePhone = (raw: string): string => {
  const trimmed = (raw || '').trim().replace(/[\s()\-]/g, '');
  if (!trimmed) return '';
  return trimmed.startsWith('+') ? trimmed : `+${trimmed}`;
};

async function sendWhatsappAutoAck(
  phoneNumberId: string,
  accessToken: string,
  toPhone: string,
  ticketNumber: number,
  contactName: string | null,
): Promise<boolean> {
  const greet = contactName ? `Hi ${contactName.split(/\s+/)[0]},` : 'Hi,';
  const body = [
    greet,
    ``,
    `Thanks for getting in touch — we've received your message and it's in our support queue as ticket #${ticketNumber}. The team will be in touch shortly. — The ReceptionMate team`,
  ].join('\n');
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
      { messaging_product: 'whatsapp', to: toPhone.replace(/^\+/, ''), type: 'text', text: { body } },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } },
    );
    return true;
  } catch (err) {
    console.error(`[SUPPORT_WA] Auto-ack send failed for ticket #${ticketNumber}:`, err);
    return false;
  }
}

export async function handleSupportWhatsappInbound(input: SupportWhatsappInput): Promise<void> {
  const phone = normalizePhone(input.fromPhone);
  if (!phone) {
    console.warn('[SUPPORT_WA] Rejected: no parseable sender phone');
    return;
  }
  if (!input.bodyText || !input.bodyText.trim()) {
    console.warn(`[SUPPORT_WA] Rejected: empty body from ${phone}`);
    return;
  }

  // Contact upsert by phone. NB: unlike email, phone is NOT globally unique in
  // the Contact table (branches/families share numbers), so we findFirst not
  // findUnique. Same-phone collisions between distinct people are rare enough
  // in the support-inbox context to accept — staff can manually merge if it happens.
  let contact = await prisma.contact.findFirst({ where: { phone } });
  if (!contact) {
    contact = await prisma.contact.create({
      data: { phone, name: input.senderName },
    });
  } else if (input.senderName && !contact.name) {
    contact = await prisma.contact.update({
      where: { id: contact.id },
      data: { name: input.senderName },
    });
  }

  if (contact.blocked) {
    console.log(`[SUPPORT_WA] Dropped blocked contact ${phone}`);
    return;
  }

  // Threading: most recent OPEN-family whatsapp ticket for this contact. If
  // solved/closed, we deliberately create a new ticket — see file header.
  const openStatuses: TicketStatus[] = [
    TicketStatus.new_, TicketStatus.open, TicketStatus.pending, TicketStatus.on_hold,
  ];
  let ticket = await prisma.ticket.findFirst({
    where: {
      contactId: contact.id,
      channel: TicketChannel.whatsapp,
      status: { in: openStatuses },
    },
    orderBy: { createdAt: 'desc' },
  });
  const created = !ticket;
  if (!ticket) {
    const title = input.bodyText.trim().slice(0, 100) || '(WhatsApp message)';
    ticket = await prisma.ticket.create({
      data: {
        title,
        channel: TicketChannel.whatsapp,
        contactId: contact.id,
        garageId: contact.garageId,
      },
    });
  }

  // Log the inbound as a public_reply from the contact.
  await prisma.ticketEntry.create({
    data: {
      ticketId: ticket.id,
      kind: TicketEntryKind.public_reply,
      authorContactId: contact.id,
      body: input.bodyText,
      outboundMessageId: input.messageId,
    },
  });

  await prisma.ticket.update({
    where: { id: ticket.id },
    data: { lastCustomerActivityAt: new Date() },
  });

  console.log(`[SUPPORT_WA] ${created ? 'Created' : 'Appended to'} ticket #${ticket.number} from ${phone}`);

  // Auto-ack + AI enrichment only fire on NEW ticket creation. Appends skip both.
  if (!created) return;

  // Auto-ack via WhatsApp — safe because inbound just reset the 24h window.
  const ackSent = await sendWhatsappAutoAck(
    input.supportPhoneNumberId,
    input.supportAccessToken,
    phone,
    ticket.number,
    contact.name,
  );
  if (ackSent) {
    await prisma.ticketEntry.create({
      data: {
        ticketId: ticket.id,
        kind: TicketEntryKind.auto_ack,
        body: `Auto-ack sent via WhatsApp to ${phone} for new ticket #${ticket.number}`,
      },
    });
  }

  // Fire-and-forget: classify + draft reply. Uses the first line as pseudo-subject
  // (WhatsApp has no subject field — the LLM classifier does fine with just the body).
  void enrichNewTicket({
    ticketId: ticket.id,
    ticketNumber: ticket.number,
    subject: input.bodyText.trim().slice(0, 100),
    body: input.bodyText,
    contactName: contact.name,
  }).catch((err: unknown) => console.error('[SUPPORT_WA] AI enrichment error:', err));
}
