// A reminder for In'n'out that matches how they are actually invoiced.
//
// The generic chaser in invoiceChase.ts attaches one PDF per garage, because for every other
// customer a garage IS the bill. In'n'out are not billed that way: inoInvoice.ts emails ONE
// combined document per month (INV-INO-2610) covering all branches, and that single PDF is the
// only thing their accounts team has ever seen. Chasing them with five branch slips asks them to
// reconcile against a document we never sent.
//
// So this rebuilds the combined invoice for each unpaid month and attaches that. The figures come
// from the stored Invoice rows rather than being recomputed from call data, so the reminder can
// never quote a total that differs from the one they were billed — a recompute would drift the
// moment a call's duration was corrected or a branch's rate changed.
//
// It also keeps overdue and not-yet-due months apart. A customer late on one month will often
// have the next month's invoice sitting in the same inbox; listing both is a kindness, but
// headlining the combined figure as overdue is a false statement about their account.

import { prisma } from '../db.js';
import { sendLatePaymentEmail } from '../utils/email.js';
import type { EmailAttachment } from '../utils/email.js';
import { renderInoInvoicePdf } from './inoInvoice.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const VAT_RATE = 0.2;
const PAYMENT_TERMS_DAYS = 14;

const gbp = (pence: number) =>
  `£${(pence / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const prettyDate = (d: Date) =>
  d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' });

const shortBranch = (name: string) => name.replace(/In'n'out Autocentres\s*/i, '').trim() || name;

/** One unpaid month: the invoice rows that make it up, plus the combined document they belong to. */
interface UnpaidMonth {
  invoiceNo: string;
  periodStart: Date;
  due: Date;
  total: number;
  subMonthLabel: string;
  ids: string[];
  pdf: Buffer | null;
}

/**
 * Reassemble the combined monthly invoice from its stored per-branch rows.
 *
 * renderInoInvoicePdf takes the same shape buildInoInvoiceData produces, so the reminder's PDF is
 * byte-for-byte the document they were sent — without touching live call data to get it.
 */
async function buildMonthFromRows(
  periodStart: Date,
  rows: Array<{
    id: string;
    garage: { name: string; businessId: string | null };
    garageId: string;
    businessId: string | null;
    minutesUsed: number;
    subscriptionAmount: number;
    minutesAmount: number;
    costPerMinuteGbp: number;
    subtotal: number;
    vatAmount: number;
    total: number;
    dueDate: Date | null;
  }>,
): Promise<UnpaidMonth> {
  const y = periodStart.getUTCFullYear();
  const m = periodStart.getUTCMonth();
  const usageStart = new Date(Date.UTC(y, m - 1, 1));
  const issued = new Date(Date.UTC(y, m, 1));
  const periodEnd = new Date(Date.UTC(y, m + 1, 1));
  // Prefer the due date actually recorded on the invoice; fall back to terms only if it is null,
  // which is how September's invoices originally escaped the chaser altogether.
  const due = rows.find((r) => r.dueDate)?.dueDate
    ?? new Date(issued.getTime() + PAYMENT_TERMS_DAYS * 86400000);

  const sorted = [...rows].sort((a, b) => a.garage.name.localeCompare(b.garage.name));
  const data = {
    lines: sorted.map((r) => ({
      branch: shortBranch(r.garage.name),
      garageId: r.garageId,
      businessId: r.businessId,
      subPence: r.subscriptionAmount,
      minutes: r.minutesUsed,
      ratePence: Math.round(r.costPerMinuteGbp * 100),
      minutesPence: r.minutesAmount,
    })),
    subtotal: rows.reduce((s, r) => s + r.subtotal, 0),
    vat: rows.reduce((s, r) => s + r.vatAmount, 0),
    total: rows.reduce((s, r) => s + r.total, 0),
    invoiceNo: `INV-INO-${String(y).slice(2)}${String(m + 1).padStart(2, '0')}`,
    issued,
    periodEnd,
    due,
    subMonthLabel: `${MONTHS[m]} ${y}`,
    usageMonthLabel: `${MONTHS[usageStart.getUTCMonth()]} ${usageStart.getUTCFullYear()}`,
  };

  // A PDF that fails to render must not stop the reminder: the amounts and dates in the email
  // body are the part that matters, and they come from the database, not the renderer.
  let pdf: Buffer | null = null;
  try {
    pdf = await renderInoInvoicePdf(data);
  } catch (err) {
    console.error(`[INO-CHASE] could not render ${data.invoiceNo}:`, err);
  }

  return {
    invoiceNo: data.invoiceNo,
    periodStart,
    due,
    total: data.total,
    subMonthLabel: data.subMonthLabel,
    ids: rows.map((r) => r.id),
    pdf,
  };
}

export interface InoChaseResult {
  to: string[];
  overdue: Array<{ invoiceNo: string; amount: string; due: string; days: number }>;
  upcoming: Array<{ invoiceNo: string; amount: string; due: string }>;
  overdueTotal: string;
  outstandingTotal: string;
  attachments: string[];
  sent: boolean;
  stamped: number;
}

/**
 * Send In'n'out a reminder for every unpaid month, by hand.
 *
 * @param to      override the recipient — used to send a test to ourselves before the real one
 * @param stamp   false leaves chaseSentAt/chase2SentAt alone (always false for a test send, or
 *                the nightly job would believe a reminder reached the customer when it reached us)
 * @param dryRun  assemble and report, send nothing
 */
export async function sendInoReminder(opts: {
  to?: string[];
  cc?: string[];
  stamp?: boolean;
  dryRun?: boolean;
  ordinal?: string;
  finalNotice?: boolean;
  now?: Date;
} = {}): Promise<InoChaseResult> {
  const now = opts.now ?? new Date();

  const rows = await prisma.invoice.findMany({
    where: {
      status: { in: ['pending', 'draft'] },
      garage: {
        name: { contains: 'autocentres', mode: 'insensitive' },
        archivedAt: null,
        isTestAccount: false,
      },
    },
    select: {
      id: true, garageId: true, businessId: true, periodStart: true, dueDate: true,
      minutesUsed: true, subscriptionAmount: true, minutesAmount: true, costPerMinuteGbp: true,
      subtotal: true, vatAmount: true, total: true,
      garage: { select: { name: true, businessId: true } },
    },
    orderBy: { periodStart: 'asc' },
  });

  const empty: InoChaseResult = {
    to: [], overdue: [], upcoming: [], overdueTotal: gbp(0), outstandingTotal: gbp(0),
    attachments: [], sent: false, stamped: 0,
  };
  if (!rows.length) {
    console.log('[INO-CHASE] nothing unpaid — no reminder to send');
    return empty;
  }

  // Group by billing month. Each group is one combined invoice.
  const byMonth = new Map<number, typeof rows>();
  for (const r of rows) {
    const key = r.periodStart.getTime();
    if (!byMonth.has(key)) byMonth.set(key, [] as any);
    (byMonth.get(key) as any).push(r);
  }

  const months: UnpaidMonth[] = [];
  for (const [key, group] of [...byMonth.entries()].sort((a, b) => a[0] - b[0])) {
    months.push(await buildMonthFromRows(new Date(key), group as any));
  }

  const overdueMonths = months.filter((m) => m.due <= now);
  const upcomingMonths = months.filter((m) => m.due > now);

  if (!overdueMonths.length) {
    console.log('[INO-CHASE] nothing past terms — no reminder to send');
    return empty;
  }

  const overdueTotal = overdueMonths.reduce((s, m) => s + m.total, 0);
  const outstandingTotal = months.reduce((s, m) => s + m.total, 0);
  const earliestDue = overdueMonths.reduce((a, b) => (a.due < b.due ? a : b)).due;
  const daysOverdue = Math.floor((now.getTime() - earliestDue.getTime()) / 864e5);

  const attachments: EmailAttachment[] = months
    .filter((m) => m.pdf)
    .map((m) => ({
      filename: `ReceptionMate-Invoice-${m.invoiceNo}.pdf`,
      content: m.pdf as Buffer,
      contentType: 'application/pdf',
    }));

  const to = opts.to ?? ['accounts@inocentres.co.uk'];
  const cc = opts.cc ?? ['dan@receptionmate.co.uk'];

  const result: InoChaseResult = {
    to,
    overdue: overdueMonths.map((m) => ({
      invoiceNo: m.invoiceNo,
      amount: gbp(m.total),
      due: prettyDate(m.due),
      days: Math.floor((now.getTime() - m.due.getTime()) / 864e5),
    })),
    upcoming: upcomingMonths.map((m) => ({
      invoiceNo: m.invoiceNo, amount: gbp(m.total), due: prettyDate(m.due),
    })),
    overdueTotal: gbp(overdueTotal),
    outstandingTotal: gbp(outstandingTotal),
    attachments: attachments.map((a) => a.filename),
    sent: false,
    stamped: 0,
  };

  if (opts.dryRun) {
    console.log(`[INO-CHASE] dry run — would send ${gbp(overdueTotal)} overdue `
      + `(${gbp(outstandingTotal)} outstanding) to ${to.join(', ')} with ${attachments.length} PDF(s)`);
    return result;
  }

  const sent = await sendLatePaymentEmail(to, {
    attachments,
    customerName: "In'n'out Autocentres",
    amount: gbp(overdueTotal),
    dueDate: prettyDate(earliestDue),
    daysOverdue,
    lines: overdueMonths.map((m) => ({
      label: `${m.invoiceNo} — ${m.subMonthLabel}`,
      amount: gbp(m.total),
    })),
    upcoming: upcomingMonths.map((m) => ({
      label: `${m.invoiceNo} — ${m.subMonthLabel}`,
      amount: gbp(m.total),
      due: prettyDate(m.due),
    })),
    totalOutstanding: upcomingMonths.length ? gbp(outstandingTotal) : undefined,
    // In'n'out pay by their own Direct Debit against the invoice, so offering to set one up
    // through us would read as though we had not noticed how they pay.
    portalUrl: process.env.PORTAL_URL || 'https://portal.receptionmate.co.uk',
    finalNotice: opts.finalNotice ?? true,
    reminderOrdinal: opts.ordinal,
  }, cc);
  result.sent = sent;

  if (!sent) {
    console.error(`[INO-CHASE] failed to send to ${to.join(', ')}`);
    return result;
  }

  // Stamp ONLY the overdue invoices, and only on a real send. Stamping a not-yet-due invoice
  // would consume its first reminder before it was ever late, and the nightly job would then skip
  // straight to the 14-day escalation when its due date passed.
  if (opts.stamp) {
    const ids = overdueMonths.flatMap((m) => m.ids);
    const existing = await prisma.invoice.findMany({
      where: { id: { in: ids } },
      select: { id: true, chaseSentAt: true },
    });
    for (const inv of existing) {
      await prisma.invoice.update({
        where: { id: inv.id },
        // First reminder for this invoice? Record it as such. Otherwise this is an escalation,
        // and chase2SentAt is what stops the nightly job sending another.
        data: inv.chaseSentAt ? { chase2SentAt: now } : { chaseSentAt: now },
      });
    }
    result.stamped = existing.length;
  }

  console.log(`[INO-CHASE] sent to ${to.join(', ')} — ${gbp(overdueTotal)} overdue, `
    + `${gbp(outstandingTotal)} outstanding, ${attachments.length} PDF(s), stamped ${result.stamped}`);
  return result;
}
