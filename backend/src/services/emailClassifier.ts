// Support hub Phase 1 — deterministic classification for inbound support email.
//
// Runs BEFORE the AI classifier (services/ticketAi.ts). Anything a hand-rolled
// rule can settle is settled here — the AI only sees what's left. Two reasons:
//
//   1. Rules are free, deterministic, and instant. AI is £/token, sometimes
//      wrong, and adds 1-3s of latency to the pipeline.
//   2. Some classifications are policy, not judgement — e.g. "Stripe invoice
//      emails go to Dan, exclude from support views" is a business rule the
//      LLM shouldn't be second-guessing.
//
// Each rule returns a partial ticket-update payload or null. The caller
// applies whichever rule matches first; falls back to AI if none do.

import { TicketCategory, TicketPriority } from '@prisma/client';

// ─── Rule inputs ────────────────────────────────────────────────────────────

export interface DeterministicInput {
  senderEmail: string;      // lower-cased
  subject: string;          // as received; trim before this
  bodyText: string;         // stripped-text (quotes removed)
  contactGarageId: string | null;  // known garage or null
}

export interface DeterministicMatch {
  category: TicketCategory;
  priority?: TicketPriority;
  // Rule name, stored on the ticket entry meta for later audit — so we can
  // see "which rule caught this" without re-running the classifier.
  rule: string;
  // Set when the rule wants to auto-assign. Route to a specific staff email,
  // resolved to userId by the caller.
  assigneeEmail?: string;
  // Set true when the rule wants the ticket kept out of the default support
  // view (e.g. supplier billing goes to Dan's queue only). Applied by the
  // caller as a category='billing' + assignee (Dan) — the view filter is a
  // frontend concern.
  excludeFromSupportView?: boolean;

  // ── What the pipeline should NOT do for this match ────────────────────────
  // Defaults are "do the normal thing"; a rule opts out explicitly.

  /** False = do not send the acknowledgement. Stripe does not need us to tell it
   *  we're on it, and a receipt is not a conversation. */
  autoAck?: boolean;
  /** False = do not spend an OpenAI call drafting a reply nobody will send. */
  aiDraft?: boolean;
  /** True = create the ticket for the audit trail, then close it immediately.
   *  A receipt is a record, not work. It stays searchable and never reaches a
   *  queue. */
  autoClose?: boolean;
}

// ─── Known supplier / transactional domains (rule: billing, assign Dan) ────
// Anything landing FROM these domains is our own supplier invoicing us or
// notifying us about our own account. It's not a customer support enquiry
// and must NEVER be replied to via the customer-support flow.

const SUPPLIER_DOMAINS: ReadonlySet<string> = new Set([
  // Payments / billing
  'stripe.com',
  'gocardless.com',
  // Telephony / infra
  'twilio.com',
  'sendgrid.com',
  // AI / voice
  'openai.com',
  'anthropic.com',
  'livekit.io',
  // Email / messaging
  'mailgun.com',
  'mailgun.net',
  'meta.com',
  'facebook.com',
  'facebookmail.com',
  'business.facebook.com',
  // Cloud
  'amazonaws.com',
  'aws.amazon.com',
  'digitalocean.com',
  // Domain / DNS
  'namecheap.com',
  'godaddy.com',
]);

const senderDomain = (email: string): string => {
  const at = email.lastIndexOf('@');
  return at >= 0 ? email.slice(at + 1).toLowerCase() : '';
};

// ─── Does this supplier email need anyone to DO something? ─────────────────
// These emails are formulaic, so the subject line is a reliable signal. The
// split matters more than the category: a £4.20 receipt and "your payment
// failed, service will be suspended" are both `billing`, and treating them the
// same is how the second one gets missed among ninety of the first.

/** Pure record. Nothing to do, ever. */
const SUPPLIER_NO_ACTION =
  /\b(receipt|invoice|statement|paid|payment (received|succeeded|confirmed)|thanks? for your payment|your subscription renewed|monthly summary|usage report)\b/i;

/** Something breaks if this is ignored. Deliberately wins over the line above:
 *  "Your invoice payment failed" contains both, and it is not a receipt. */
const SUPPLIER_ACTION_NEEDED =
  /\b(failed|failure|declined|decline|unpaid|overdue|past due|action required|action needed|expir(e|es|ed|ing)|suspend(ed|ing|sion)?|cancel(led|lation)?|disabl(e|ed)|deactivat(e|ed)|urgent|security alert|unable to (charge|process)|could not (charge|process)|update your (card|payment|billing))\b/i;

// ─── Our own notifications to ourselves ────────────────────────────────────
// Some of what lands at hello@ is the portal telling us something, not a person
// writing in. A website lead is already a contact and an opportunity in
// HighLevel by the time this email arrives, so a ticket for it is a second copy
// of a record that lives somewhere better.
//
// Only genuinely redundant notifications belong here. Voice-support escalations
// ("Support call: ...") and demo requests are NOT redundant — somebody has to
// act on them — so they are deliberately absent and stay in the queue.
const SELF_NOTIFICATION_SUBJECTS = [
  /^new website lead\b/i,
];

// ─── Complaint keywords (rule: complaint + high priority IF known garage) ──
// Deliberately narrow — false positives here bump priority which pages Dan.
// Broader classification is the AI's job.

const COMPLAINT_SIGNALS =
  /\b(complain(t|ing)?|unhappy|not happy|disappointed|awful|terrible service|worst service|refund me|want a refund|charging me for|overcharg(ed|ing)|threat.*legal|solicitor|small claims|trading standards|ombudsman|cancel my account|leaving you|going elsewhere|switch(ing)? provider)\b/i;

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Try the rules in priority order. Returns the first match, or null if no
 * rule fires — in which case the caller falls back to the AI classifier.
 */
export function classifyDeterministic(input: DeterministicInput): DeterministicMatch | null {
  const domain = senderDomain(input.senderEmail);

  // Rule 1: supplier / transactional domain → billing → Dan
  // Match on suffix so subdomains (bills.stripe.com) still catch.
  for (const supplier of SUPPLIER_DOMAINS) {
    if (domain === supplier || domain.endsWith(`.${supplier}`)) {
      const haystack = `${input.subject} ${input.bodyText.slice(0, 500)}`;
      // Check "needs action" first: a failed-payment notice often quotes the
      // invoice it failed on, so the no-action words are present too.
      const needsAction = SUPPLIER_ACTION_NEEDED.test(haystack);
      const routine = !needsAction && SUPPLIER_NO_ACTION.test(haystack);

      return {
        category: TicketCategory.billing,
        priority: needsAction ? TicketPriority.high : TicketPriority.normal,
        rule: `supplier_domain:${supplier}` + (needsAction ? ':action' : routine ? ':routine' : ''),
        assigneeEmail: process.env.SUPPORT_BILLING_ASSIGNEE_EMAIL || 'dan@receptionmate.co.uk',
        excludeFromSupportView: true,
        // Never acknowledge or draft to a supplier, whichever kind it is.
        autoAck: false,
        aiDraft: false,
        // Only file it away when it clearly reads as a record. Anything a
        // supplier sends that we cannot confidently call routine stays open —
        // a misfiled receipt costs nothing, a missed card decline costs the
        // service.
        autoClose: routine,
      };
    }
  }

  // Rule 2: our own notification about something already recorded elsewhere.
  // Scoped to our own sending domain so a customer cannot trigger it by subject.
  if (/(^|\.)receptionmate\.co\.uk$/i.test(domain)
      && SELF_NOTIFICATION_SUBJECTS.some((re) => re.test(input.subject.trim()))) {
    return {
      category: TicketCategory.sales_enquiry,
      rule: 'self_notification:website_lead',
      autoAck: false,
      aiDraft: false,
      // Kept for the audit trail, closed on arrival: HighLevel owns the lead.
      autoClose: true,
    };
  }

  // Rule 3: complaint language + known garage → complaint, HIGH priority.
  // Unknown-garage complaints stay for AI to classify — the priority bump
  // matters most when we know it's from an actual paying customer.
  if (input.contactGarageId && (COMPLAINT_SIGNALS.test(input.subject) || COMPLAINT_SIGNALS.test(input.bodyText))) {
    return {
      category: TicketCategory.complaint,
      priority: TicketPriority.high,
      rule: 'complaint_keyword+known_garage',
    };
  }

  // Nothing matched — let the AI take it.
  return null;
}
