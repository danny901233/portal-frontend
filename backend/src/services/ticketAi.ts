// Support hub Phase 1a — AI enrichment on new tickets.
//
// After a new ticket is created from an inbound email, we call OpenAI to:
//   1. Classify the category (billing/agent_bug/setup_help/sales_enquiry/complaint/other)
//   2. Draft a suggested reply, saved as public_reply with isDraft=true
//
// The draft is Dan's hard rule 3 in action for email: the AI never SENDS
// unassisted — it only puts a draft in front of staff, who edit and send.
// Only `auto_ack` bypasses this (see Phase 1 handler).
//
// Both calls are best-effort. Failures log and move on — the ticket exists,
// staff can classify + reply manually. We do NOT want AI hiccups to block
// the ingest pipeline.

import OpenAI from 'openai';
import { TicketCategory, TicketEntryKind } from '@prisma/client';
import { prisma } from '../db.js';

let client: OpenAI | null = null;
const oa = () => (client ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY }));

// Sync with the TicketCategory enum in schema.prisma. Comments here are what
// the model uses to decide — keep short and orthogonal.
const CATEGORY_GUIDE = `
- billing: invoicing, payment, refunds, subscription/plan changes, direct-debit questions
- agent_bug: complaint or report about the AI agent's behaviour on a call/chat (missed booking, wrong info, misheard reg)
- setup_help: onboarding, configuration, integrations, "how do I connect X", credential setup
- sales_enquiry: prospect asking about becoming a ReceptionMate customer, pricing, demos
- complaint: unhappy with the service overall (not agent-specific)
- other: legitimate customer/prospect message that doesn't fit above
`.trim();

const VALID_CATEGORIES = new Set<string>([
  'billing', 'agent_bug', 'setup_help', 'sales_enquiry', 'complaint', 'other',
]);

async function classifyEmail(subject: string, body: string): Promise<TicketCategory | null> {
  try {
    const r = await oa().chat.completions.create({
      model: 'gpt-4.1-mini',
      messages: [
        {
          role: 'system',
          content:
            'Classify a support email into exactly ONE category. Reply with the category name only — no punctuation, no explanation.\n\n' +
            CATEGORY_GUIDE,
        },
        {
          role: 'user',
          content: `SUBJECT: ${subject}\n\nBODY:\n${body.slice(0, 4000)}`,
        },
      ],
      temperature: 0,
      max_tokens: 12,
    });
    const raw = (r.choices[0]?.message?.content ?? '').trim().toLowerCase();
    if (VALID_CATEGORIES.has(raw)) return raw as TicketCategory;
    console.warn(`[TICKET_AI] classifyEmail returned unknown value: ${JSON.stringify(raw)}`);
    return null;
  } catch (err) {
    console.error('[TICKET_AI] classifyEmail failed:', err);
    return null;
  }
}

async function draftReply(args: {
  subject: string;
  body: string;
  contactName: string | null;
  ticketNumber: number;
}): Promise<string | null> {
  try {
    const r = await oa().chat.completions.create({
      model: 'gpt-4.1',
      messages: [
        {
          role: 'system',
          content: [
            'You draft support-email replies for a ReceptionMate staff member to REVIEW before sending.',
            'Voice: warm, professional British English. Concise. Under 180 words.',
            'Rules:',
            '- NEVER invent facts, prices, dates, timelines, or account details.',
            '- If you cannot answer confidently, say the team will follow up shortly with the specifics.',
            '- Address the customer by first name if given, otherwise "Hi there".',
            '- Sign off "— The ReceptionMate team".',
            '- Do NOT include a subject line, "Re:", or any header. Reply body only.',
            '- Do NOT promise refunds, discounts, or any commercial action.',
          ].join('\n'),
        },
        {
          role: 'user',
          content:
            `Customer name: ${args.contactName || 'unknown'}\n` +
            `Ticket #${args.ticketNumber}\n` +
            `Subject: ${args.subject}\n\n` +
            `Message from customer:\n${args.body.slice(0, 4000)}`,
        },
      ],
      temperature: 0.4,
      max_tokens: 400,
    });
    const draft = (r.choices[0]?.message?.content ?? '').trim();
    return draft || null;
  } catch (err) {
    console.error('[TICKET_AI] draftReply failed:', err);
    return null;
  }
}

// ─── Public entry point ─────────────────────────────────────────────────────
// Called async (fire-and-forget) from the mailgun-inbound handler after a new
// ticket + auto-ack have been committed. Both LLM calls are independent — a
// failure of one doesn't block the other. Both persist their result directly.

export async function enrichNewTicket(args: {
  ticketId: string;
  ticketNumber: number;
  subject: string;
  body: string;
  contactName: string | null;
}): Promise<void> {
  const [category, draft] = await Promise.all([
    classifyEmail(args.subject, args.body),
    draftReply({
      subject: args.subject,
      body: args.body,
      contactName: args.contactName,
      ticketNumber: args.ticketNumber,
    }),
  ]);

  if (category) {
    try {
      await prisma.ticket.update({
        where: { id: args.ticketId },
        data: { category },
      });
      console.log(`[TICKET_AI] ticket #${args.ticketNumber} classified as ${category}`);
    } catch (err) {
      console.error(`[TICKET_AI] failed to persist category for ticket #${args.ticketNumber}:`, err);
    }
  }

  if (draft) {
    try {
      await prisma.ticketEntry.create({
        data: {
          ticketId: args.ticketId,
          kind: TicketEntryKind.public_reply,
          // No author — system-drafted. Staff who approves + sends will replace with a signed entry.
          body: draft,
          isDraft: true,
        },
      });
      console.log(`[TICKET_AI] ticket #${args.ticketNumber} draft reply saved (${draft.length} chars)`);
    } catch (err) {
      console.error(`[TICKET_AI] failed to persist draft for ticket #${args.ticketNumber}:`, err);
    }
  }
}
