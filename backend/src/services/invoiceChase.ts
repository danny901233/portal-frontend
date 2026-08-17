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
    include: { garage: { select: { id: true, name: true } } },
    orderBy: { dueDate: 'asc' },
  });

  // Group by garage so a multi-branch customer gets ONE email listing every branch, not four.
  // In'n'out are billed as four branches on a single combined invoice; chasing each separately
  // would be four emails for one debt.
  const groups = new Map<string, typeof due>();
  for (const inv of due) {
    // Bucket by the chase stage this invoice is at, so first and second reminders don't mix.
    const stage = !inv.chaseSentAt ? 'first'
      : (!inv.chase2SentAt && inv.chaseSentAt <= secondChaseCutoff) ? 'second'
      : 'done';
    if (stage === 'done') continue;
    const key = `${stage}`;
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

    // Where does it go? The billing contact for the first garage in the group.
    const user = await prisma.user.findFirst({
      where: { garageAccessIds: { has: invoices[0].garage.id } },
      select: { email: true },
    });
    if (!user) {
      console.warn(`[INVOICE_CHASE] no billing contact for ${invoices[0].garage.name} — skipped`);
      continue;
    }

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
