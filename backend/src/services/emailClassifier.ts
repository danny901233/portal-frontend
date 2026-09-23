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
      return {
        category: TicketCategory.billing,
        priority: TicketPriority.normal,
        rule: `supplier_domain:${supplier}`,
        assigneeEmail: process.env.SUPPORT_BILLING_ASSIGNEE_EMAIL || 'dan@receptionmate.co.uk',
        excludeFromSupportView: true,
      };
    }
  }

  // Rule 2: complaint language + known garage → complaint, HIGH priority.
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
