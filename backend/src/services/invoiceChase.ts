// Chases invoice-paying customers whose payment is past terms.
//
// Direct Debit customers can't be late in this sense — a collection either succeeds or fails, and
// the failure path handles it. Invoice customers (In'n'out) settle by bank transfer, so their
// invoices sit 'pending' by design and nothing in the system ever noticed when the 14-day terms
// came and went. In'n'out's July invoice happened to be paid on time; had it not been, nobody
// would have known.
//
// Two chases, then stop and leave it to a human:
//   1. on the due date (issue + 14 days)
//   2. 14 days later, firmer, referencing the 30-day suspension clause in the agreement
//
// Both are recorded on the invoice so a daily run can't spam the same customer.

import { prisma } from '../db.js';
import { sendLatePaymentEmail } from '../utils/email.js';
import { createPaymentSetupLink } from './directDebitRequestEmail.js';

const SECOND_CHASE_DAYS = 14;

function money(pence: number): string {
  return '£' + (pence / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function prettyDate(d: Date): string {
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' });
}

/**
 * Who should a payment reminder actually go to?
 *
 * A branch mailbox is answered by whoever is on the counter. Sending them a demand for the whole
 * group's balance is both wrong and embarrassing, so an explicit billing address always wins, and
 * a login that spans every branch (which is what an accounts person looks like in our data) beats
 * one that only sees a single branch.
 */
async function resolveBillingContact(
  invoices: { businessId: string | null; garage: { id: string; name: string } }[],
): Promise<string | null> {
  const businessId = invoices.find((i) => i.businessId)?.businessId ?? null;

  if (businessId) {
    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: { billingEmail: true, contactEmail: true },
    });
    const explicit = business?.billingEmail || business?.contactEmail;
    if (explicit) return explicit;
  }

  // No explicit address recorded. Prefer whoever can see the most of the branches being chased —
  // a group-wide login is the accounts contact; a single-branch login is the counter.
  const garageIds = invoices.map((i) => i.garage.id);
  const candidates = await prisma.user.findMany({
    where: { garageAccessIds: { hasSome: garageIds } },
    select: { email: true, role: true, garageAccessIds: true, createdAt: true },
  });
  if (!candidates.length) return null;

  const scored = candidates
    .filter((u) => u.role !== 'RECEPTIONMATE_STAFF')            // never chase ourselves
    .map((u) => ({
      email: u.email,
      covered: garageIds.filter((g) => u.garageAccessIds.includes(g)).length,
      // "accounts@", "finance@", "billing@" is a strong hint even without a business record.
      named: /^(accounts?|finance|billing|invoices?|ap)@/i.test(u.email) ? 1 : 0,
      createdAt: u.createdAt,
    }))
    .sort((a, b) =>
      b.named - a.named ||
      b.covered - a.covered ||
      a.createdAt.getTime() - b.createdAt.getTime());

  return scored[0]?.email ?? null;
}

export async function chaseOverdueInvoices(): Promise<{ first: number; second: number }> {
  const now = new Date();
  const secondChaseCutoff = new Date(now.getTime() - SECOND_CHASE_DAYS * 864e5);

  // Only invoice-payers, only genuinely unpaid, only past their due date.
  const due = await prisma.invoice.findMany({
    where: {
      status: { in: ['pending', 'draft'] },
      dueDate: { not: null, lte: now },
      garage: { paymentMethod: 'invoice', archivedAt: null, isTestAccount: false },
    },
    include: { garage: { select: { id: true, name: true, businessId: true } } },
    orderBy: { dueDate: 'asc' },
  });

  // Group by BUSINESS and stage. A multi-branch customer gets one email listing every branch —
  // In'n'out are billed as five branches on a single combined invoice, and chasing each
  // separately would be five emails for one debt.
  //
  // Keying on the stage alone (as this first did) merged every invoice customer who happened to
  // be overdue on the same day into a single email, listing one company's branches and amounts
  // to another company's billing contact. Only one customer pays by invoice today, so nothing
  // leaked, but it would have the moment a second one did.
  const groups = new Map<string, typeof due>();
  for (const inv of due) {
    const stage = !inv.chaseSentAt ? 'first'
      : (!inv.chase2SentAt && inv.chaseSentAt <= secondChaseCutoff) ? 'second'
      : 'done';
    if (stage === 'done') continue;
    const owner = inv.businessId || inv.garage.id;   // no business? then it is its own group
    const key = `${owner}:${stage}`;
    if (!groups.has(key)) groups.set(key, [] as any);
    (groups.get(key) as any).push(inv);
  }

  let first = 0;
  let second = 0;

  for (const [stage, invoices] of groups) {
    if (!invoices.length) continue;

    const total = invoices.reduce((a, b) => a + b.total, 0);
    const lines = invoices.map((i) => ({ label: i.garage.name, amount: money(i.total) }));
    const earliestDue = invoices.reduce((a, b) => (a.dueDate! < b.dueDate! ? a : b)).dueDate!;
    const daysOverdue = Math.floor((now.getTime() - earliestDue.getTime()) / 864e5);

    // Where does it go? This matters more than it looks. The first version took whichever login
    // happened to be attached to the first garage in the group, which for In'n'out meant a
    // £1,855 payment demand landing in a branch counter mailbox rather than with their accounts
    // team. Resolve a real billing contact, in order of how much we should trust it.
    const to = await resolveBillingContact(invoices);
    if (!to) {
      console.warn(`[INVOICE_CHASE] no billing contact for ${invoices[0].garage.name} — skipped`);
      continue;
    }
    const user = { email: to };

    let ddSetupUrl: string | undefined;
    try {
      ddSetupUrl = await createPaymentSetupLink(user.email);
    } catch {
      // No portal user to attach a token to — send without the Direct Debit offer rather than
      // shipping a button that goes nowhere.
      ddSetupUrl = undefined;
    }

    const sent = await sendLatePaymentEmail([user.email], {
      customerName: invoices[0].garage.name.replace(/ (Autocentres|Garage).*$/, ''),
      amount: money(total),
      dueDate: prettyDate(earliestDue),
      daysOverdue,
      lines: lines.length > 1 ? lines : undefined,
      ddSetupUrl,
      portalUrl: process.env.PORTAL_URL || 'https://portal.receptionmate.co.uk',
      finalNotice: stage === 'second',
    }, ['dan@receptionmate.co.uk']);

    if (!sent) {
      console.error(`[INVOICE_CHASE] failed to send ${stage} reminder to ${user.email}`);
      continue;
    }

    // Stamping is what stops a second reminder going out tomorrow. It lives immediately after the
    // send, and any manual reminder MUST go through this same path — see sendChaseNow below.
    for (const inv of invoices) {
      await prisma.invoice.update({
        where: { id: inv.id },
        data: stage === 'first' ? { chaseSentAt: now } : { chase2SentAt: now },
      });
    }
    if (stage === 'first') first += invoices.length; else second += invoices.length;
    console.log(`[INVOICE_CHASE] ${stage} reminder sent to ${user.email} — ${money(total)}, ${daysOverdue} days overdue, ${invoices.length} invoice(s)`);
  }

  if (first || second) {
    console.log(`[INVOICE_CHASE] first reminders: ${first}, second reminders: ${second}`);
  }
  return { first, second };
}


/**
 * Send a reminder for one business right now, by hand, and record it.
 *
 * This exists because a reminder was once sent with an ad-hoc script that called
 * sendLatePaymentEmail directly. It reached the right people, but nothing wrote chaseSentAt — so
 * the nightly job saw four invoices it believed had never been chased and sent the whole thing
 * again the next morning, to the wrong mailbox. The customer got the same demand twice in fifteen
 * hours.
 *
 * So: never send a payment reminder outside this function. It sends and stamps together, and a
 * dry run tells you who it would reach before anything leaves.
 */
export async function sendChaseNow(
  businessId: string,
  opts: { dryRun?: boolean } = {},
): Promise<{ to: string | null; amount: string; invoices: number; sent: boolean }> {
  const invoices = await prisma.invoice.findMany({
    where: {
      businessId,
      status: { in: ['pending', 'draft'] },
      garage: { archivedAt: null, isTestAccount: false },
    },
    include: { garage: { select: { id: true, name: true, businessId: true } } },
    orderBy: { dueDate: 'asc' },
  });
  if (!invoices.length) return { to: null, amount: money(0), invoices: 0, sent: false };

  const to = await resolveBillingContact(invoices);
  const total = invoices.reduce((a, b) => a + b.total, 0);
  if (opts.dryRun || !to) {
    console.log(`[INVOICE_CHASE] dry run — would send ${money(total)} for ${invoices.length} invoice(s) to ${to ?? 'NOBODY'}`);
    return { to, amount: money(total), invoices: invoices.length, sent: false };
  }

  const earliestDue = invoices.reduce((a, b) => ((a.dueDate ?? a.createdAt) < (b.dueDate ?? b.createdAt) ? a : b));
  const due = earliestDue.dueDate ?? earliestDue.createdAt;
  const now = new Date();

  let ddSetupUrl: string | undefined;
  try {
    ddSetupUrl = await createPaymentSetupLink(to);
  } catch {
    ddSetupUrl = undefined;
  }

  const sent = await sendLatePaymentEmail([to], {
    customerName: invoices[0].garage.name.replace(/ (Autocentres|Garage).*$/, ''),
    amount: money(total),
    dueDate: prettyDate(due),
    daysOverdue: Math.floor((now.getTime() - due.getTime()) / 864e5),
    lines: invoices.length > 1
      ? invoices.map((i) => ({ label: i.garage.name, amount: money(i.total) }))
      : undefined,
    ddSetupUrl,
    portalUrl: process.env.PORTAL_URL || 'https://portal.receptionmate.co.uk',
    finalNotice: false,
  }, ['dan@receptionmate.co.uk']);

  if (sent) {
    for (const inv of invoices) {
      await prisma.invoice.update({ where: { id: inv.id }, data: { chaseSentAt: now } });
    }
    console.log(`[INVOICE_CHASE] manual reminder sent to ${to} — ${money(total)}, ${invoices.length} invoice(s), stamped`);
  }
  return { to, amount: money(total), invoices: invoices.length, sent };
}
