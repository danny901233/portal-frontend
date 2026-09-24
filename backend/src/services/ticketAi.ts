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
// Classification is only invoked when the deterministic rules
// (services/emailClassifier.ts) return no match — rules are cheap, instant,
// and business-policy driven, so they get first refusal. The AI only sees
// what the rules couldn't settle. Drafting always runs (deterministic rules
// don't produce a suggested reply).
//
// Both calls are best-effort. Failures log and move on — the ticket exists,
// staff can classify + reply manually. We do NOT want AI hiccups to block
// the ingest pipeline.

import OpenAI from 'openai';
import { TicketCategory, TicketEntryKind, TicketStatus } from '@prisma/client';
import { prisma } from '../db.js';
import { highlevelConfigured, upsertContact, createOpportunity } from './highlevel.js';

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
- spam: unsolicited mail selling TO ReceptionMate — marketing, SEO, lead generation, advertising, recruitment, "partnership" pitches, newsletters, phishing. Nobody asked for it and it needs no reply. (A prospect wanting to BUY ReceptionMate is sales_enquiry, never spam.)
`.trim();

const VALID_CATEGORIES = new Set<string>([
  'billing', 'agent_bug', 'setup_help', 'sales_enquiry', 'complaint', 'other', 'spam',
]);

/** Below this the model's spam verdict tags the ticket but leaves it in the
 *  queue for a person to close; at or above it the ticket is filed closed on
 *  arrival. A wrongly-closed enquiry is the costly mistake, so the bar is high. */
const SPAM_AUTOCLOSE_CONFIDENCE = 0.8;

// Return shape includes a confidence proxy so we can:
//  - store it on the draft entry meta for later audit
//  - down the line, gate auto-actions on it (only auto-assign at >0.8, etc.)
// Confidence is derived from the model's log-probability of the chosen token,
// so it needs logprobs enabled on the completion request.
export interface AiClassification {
  category: TicketCategory;
  confidence: number;   // 0.0–1.0
  model: string;        // e.g. 'gpt-4.1-mini'
}

const CLASSIFIER_MODEL = 'gpt-4.1-mini';

async function classifyEmail(subject: string, body: string): Promise<AiClassification | null> {
  try {
    const r = await oa().chat.completions.create({
      model: CLASSIFIER_MODEL,
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
      // Ask for token-level log-probabilities on the chosen category token so we
      // can surface a confidence score. Falls back to 0.5 if the API doesn't
      // return them (older model versions, etc.).
      logprobs: true,
    });
    const raw = (r.choices[0]?.message?.content ?? '').trim().toLowerCase();
    if (!VALID_CATEGORIES.has(raw)) {
      console.warn(`[TICKET_AI] classifyEmail returned unknown value: ${JSON.stringify(raw)}`);
      return null;
    }
    const firstTokenLogprob = r.choices[0]?.logprobs?.content?.[0]?.logprob;
    const confidence =
      typeof firstTokenLogprob === 'number' && Number.isFinite(firstTokenLogprob)
        ? Math.exp(firstTokenLogprob)
        : 0.5;
    return {
      category: raw as TicketCategory,
      confidence,
      model: CLASSIFIER_MODEL,
    };
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
            '- Do NOT add a sign-off or signature — one is appended automatically when the email is sent.',
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
//
// `skipClassification` = the deterministic classifier (services/emailClassifier)
// already settled the category, so we don't call the AI classifier at all. The
// draft still runs — rules can settle a category but can't write a reply.

/**
 * Put a sales enquiry that arrived by email into the CRM.
 *
 * Someone who fills in the website form becomes a HighLevel contact and an
 * opportunity. Someone who simply emails hello@ saying "how much is it?" used to
 * become neither — they were answered, and never appeared in the pipeline, so
 * they were invisible to every follow-up sequence and every conversion figure.
 *
 * The conversation still belongs in the ticket queue; this only mirrors the
 * pipeline entry. createOpportunity upserts and only ever moves a contact
 * forward, so somebody already on trial who emails a question cannot be dragged
 * back to the enquiry stage.
 *
 * Best-effort: a CRM hiccup must never interfere with answering the customer.
 */
async function recordSalesEnquiryInCrm(args: {
  ticketNumber: number;
  contactEmail: string;
  contactName: string | null;
}): Promise<void> {
  if (!highlevelConfigured()) return;
  try {
    const name = args.contactName?.trim() || args.contactEmail.split('@')[0];
    const { contactId } = await upsertContact({
      name,
      email: args.contactEmail,
      source: 'support email',
      tags: [process.env.GHL_EMAIL_ENQUIRY_TAG || 'email-enquiry'],
    });
    if (!contactId) return;

    await createOpportunity({ contactId, name: `${name} — email enquiry`, kind: 'lead' });
    console.log(`[TICKET_AI] ticket #${args.ticketNumber} mirrored to HighLevel as a lead (${args.contactEmail})`);
  } catch (err) {
    console.error(`[TICKET_AI] HighLevel push failed for ticket #${args.ticketNumber}:`, err);
  }
}

export async function enrichNewTicket(args: {
  ticketId: string;
  ticketNumber: number;
  subject: string;
  body: string;
  contactName: string | null;
  contactEmail?: string | null;
  skipClassification?: boolean;
}): Promise<{ spam: boolean }> {
  const [classification, draft] = await Promise.all([
    args.skipClassification ? Promise.resolve(null) : classifyEmail(args.subject, args.body),
    draftReply({
      subject: args.subject,
      body: args.body,
      contactName: args.contactName,
      ticketNumber: args.ticketNumber,
    }),
  ]);

  // Spam is filed, not worked: no draft, no CRM mirror, and the caller holds
  // back the acknowledgement. Confident verdicts close the ticket outright;
  // hesitant ones leave it tagged in the queue for a person to close.
  if (classification?.category === TicketCategory.spam) {
    const confident = classification.confidence >= SPAM_AUTOCLOSE_CONFIDENCE;
    try {
      await prisma.$transaction([
        prisma.ticket.update({
          where: { id: args.ticketId },
          data: {
            category: TicketCategory.spam,
            ...(confident ? { status: TicketStatus.closed, closedAt: new Date() } : {}),
          },
        }),
        prisma.ticketEntry.create({
          data: {
            ticketId: args.ticketId,
            kind: TicketEntryKind.status_change,
            body: confident
              ? `Filed as spam by the classifier (confidence ${classification.confidence.toFixed(2)})`
              : `Looks like spam to the classifier (confidence ${classification.confidence.toFixed(2)}) — left for a person to confirm`,
          },
        }),
      ]);
      console.log(
        `[TICKET_AI] ticket #${args.ticketNumber} classified as spam ` +
        `(confidence=${classification.confidence.toFixed(3)}, ${confident ? 'closed' : 'left open'})`,
      );
    } catch (err) {
      console.error(`[TICKET_AI] failed to file ticket #${args.ticketNumber} as spam:`, err);
    }
    return { spam: true };
  }

  if (classification) {
    try {
      await prisma.ticket.update({
        where: { id: args.ticketId },
        data: { category: classification.category },
      });
      console.log(
        `[TICKET_AI] ticket #${args.ticketNumber} classified as ${classification.category} ` +
        `(confidence=${classification.confidence.toFixed(3)}, model=${classification.model})`,
      );
    } catch (err) {
      console.error(`[TICKET_AI] failed to persist category for ticket #${args.ticketNumber}:`, err);
    }

    if (classification.category === TicketCategory.sales_enquiry && args.contactEmail) {
      await recordSalesEnquiryInCrm({
        ticketNumber: args.ticketNumber,
        contactEmail: args.contactEmail,
        contactName: args.contactName,
      });
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
          // Store classification confidence + model on the draft so the UI (and
          // future audit) can see how sure the classifier was. Null when the
          // deterministic classifier handled it — the rule name is on the
          // Mailgun event row instead.
          meta: classification
            ? {
                aiClassification: {
                  category: classification.category,
                  confidence: classification.confidence,
                  model: classification.model,
                },
              }
            : undefined,
        },
      });
      console.log(`[TICKET_AI] ticket #${args.ticketNumber} draft reply saved (${draft.length} chars)`);
    } catch (err) {
      console.error(`[TICKET_AI] failed to persist draft for ticket #${args.ticketNumber}:`, err);
    }
  }
  return { spam: false };
}
