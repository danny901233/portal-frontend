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
  /** Message headers, names lower-cased. See parseMailgunHeaders. */
  headers?: Record<string, string>;
}

// ─── Header parsing ─────────────────────────────────────────────────────────
// Mailgun posts the full header set as `message-headers`: a JSON string of
// [name, value] pairs. Names are folded to lower case here so a rule can ask
// for 'list-unsubscribe' without caring how the sending MTA capitalised it.
// A repeated header keeps its first value — Received is the only one that
// repeats and nothing below reads it.

export function parseMailgunHeaders(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof raw !== 'string' || !raw) return out;
  try {
    const pairs = JSON.parse(raw);
    if (!Array.isArray(pairs)) return out;
    for (const pair of pairs) {
      if (!Array.isArray(pair) || typeof pair[0] !== 'string') continue;
      const name = pair[0].toLowerCase();
      if (name in out) continue;
      out[name] = typeof pair[1] === 'string' ? pair[1] : String(pair[1] ?? '');
    }
  } catch {
    // A header block we cannot parse is not a reason to lose the email.
  }
  return out;
}

// ─── Automated senders ──────────────────────────────────────────────────────
// A mailbox nobody reads. Two things follow: we never auto-acknowledge it
// (replying to mailer-daemon loops, replying to a no-reply alias damages our
// sending reputation), and when it belongs to no garage we know, what it sent
// is a notification rather than a conversation. Regex matches the LOCAL PART
// so noreply@anything, no-reply.foo@bar and support-noreply@baz all fire.
// `+` is a separator too: VERP return paths look like `bounce+ae18a6.57875-...@`,
// and without it the guard reads that as an ordinary local part and cheerfully
// auto-acknowledges a bounce handler.
const NO_REPLY_LOCAL = /(^|[.\-_+])(no[-_.]?reply|donot[-_.]?reply|mailer[-_.]?daemon|postmaster|bounce[s]?|notifications?)([.\-_+]|$)/i;

export const isNoReplySender = (email: string): boolean => {
  const local = email.split('@')[0] || '';
  if (NO_REPLY_LOCAL.test(local)) return true;
  if (email.startsWith('mailer-daemon@')) return true;
  return false;
};

// ─── Bulk mail ──────────────────────────────────────────────────────────────
// A person writing to us from their mail client sets none of these. A campaign
// tool sets at least one on every message it sends, because the RFCs and the
// big receivers require it. So their presence on mail from someone we do not
// know is the cheapest possible test for "was this written to us, or at us".
//
// Known contacts (linked to a garage) are exempt: a customer who happens to
// mail us through a CRM is still a customer.

const BULK_HEADERS = ['list-unsubscribe', 'list-unsubscribe-post', 'list-id', 'x-campaign-id', 'x-mailgun-campaign-id'];

/** Which bulk marker fired, or null. The name goes into the rule label so the
 *  audit trail says WHY a ticket was filed, not just that it was. */
const bulkMarker = (headers: Record<string, string> | undefined): string | null => {
  if (!headers) return null;
  // Mailgun's own verdict, when inbound spam filtering is switched on for the
  // route. Absent otherwise, so it never fires by accident.
  if (/^yes$/i.test(headers['x-mailgun-sflag'] ?? '')) return 'x-mailgun-sflag';
  for (const h of BULK_HEADERS) if (headers[h]) return h;
  if (/\b(bulk|list|junk)\b/i.test(headers['precedence'] ?? '')) return 'precedence';
  return null;
};

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

// ─── Our own operational mail worth queueing ───────────────────────────────
// Most of what our own systems send to hello@ is a record: a per-call
// notification addressed to a garage that happens to be us, a lead notice
// HighLevel already owns. Those file on arrival like any other robot's mail.
//
// These three do not. Two are the watchdog saying an agent is down or back up,
// and one is the nightly call report. They are the mail most worth seeing, and
// filing them on arrival buries an outage in a queue nobody opens.
const OURS_WORTH_QUEUEING: ReadonlyArray<RegExp> = [
  /ReceptionMate ALERT/i,
  /issue\(s\) recovered/i,
  /^ReceptionMate daily\b/i,
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

  // Rule 3: bulk / marketing mail from someone we do not know → spam.
  // Filed closed for the audit trail; nothing else happens. No acknowledgement
  // (that confirms the address is live), no draft, no phone buzz.
  if (!input.contactGarageId) {
    const marker = bulkMarker(input.headers);
    if (marker) {
      return {
        category: TicketCategory.spam,
        rule: `bulk_mail:${marker}`,
        autoAck: false,
        aiDraft: false,
        autoClose: true,
      };
    }
  }

  // Rule 4: an automated sender we have no relationship with → a notification,
  // not a conversation. Magic links, vendor announcements. Never acknowledged
  // and never drafted to.
  //
  // Whether it CLOSES on arrival depends on what it is. Everything files by
  // default; only our own alerts and the nightly report stay in the queue
  // (OURS_WORTH_QUEUEING above).
  if (!input.contactGarageId && isNoReplySender(input.senderEmail)) {
    const ours = /(^|\.)receptionmate\.co\.uk$/i.test(domain);
    const keep = ours && OURS_WORTH_QUEUEING.some((re) => re.test(input.subject));
    return {
      category: TicketCategory.other,
      rule: keep ? 'automated_sender:ours_alert' : ours ? 'automated_sender:ours' : 'automated_sender:external',
      autoAck: false,
      aiDraft: false,
      autoClose: !keep,
    };
  }

  // Rule 5: complaint language + known garage → complaint, HIGH priority.
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
