// The notice that goes out before In'n'out's account is actually restricted.
//
// inoChase.ts chases; this warns. They are separate because the chaser is allowed to run nightly
// off a schedule, and a notice that names a date on which we will withhold someone's call data is
// not something a cron job should be able to send on its own — it goes out when a person decides
// to send it, and the restriction date is passed in rather than inferred.
//
// The figures come from the stored Invoice rows and the attachment is the same combined document
// they were billed with, for the reason spelled out at the top of inoChase.ts: a reminder that
// quotes a total they cannot find on a document we sent them is a reminder they can argue with.

import { prisma } from '../db.js';
import { sendArrearsRestrictionNoticeEmail } from '../utils/email.js';
import type { EmailAttachment } from '../utils/email.js';
import { buildMonthFromRows, type UnpaidMonth } from './inoChase.js';

/** What the agreement promises, and what the 1 Oct chase repeated: 30 days, then 5 days' notice. */
const TERMS_NOTICE_DAYS = 5;

const gbp = (pence: number) =>
  `£${(pence / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** "Thursday 15 October" — no year: the notice is about a date days away, not a filing reference.
 *  en-GB puts a comma after the weekday, which reads wrong inside a sentence, so it comes out. */
const noticeDate = (d: Date) =>
  d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/London' })
    .replace(',', '');

const prettyDate = (d: Date) =>
  d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' });

export interface InoRestrictionNoticeResult {
  to: string[];
  cc: string[];
  restrictionDate: string;
  noticeDays: number;
  overdue: Array<{ invoiceNo: string; amount: string; due: string; days: number }>;
  upcoming: Array<{ invoiceNo: string; amount: string; due: string }>;
  overdueTotal: string;
  outstandingTotal: string;
  attachments: string[];
  sent: boolean;
}

/**
 * Warn In'n'out that the account will be restricted, and on which day.
 *
 * @param restrictOn  the day the restriction starts. Required: the email states it as a promise.
 * @param to          override the recipient, to send a copy to ourselves first
 * @param dryRun      assemble and report, send nothing
 */
export async function sendInoRestrictionNotice(opts: {
  restrictOn: Date;
  to?: string[];
  cc?: string[];
  dryRun?: boolean;
  now?: Date;
}): Promise<InoRestrictionNoticeResult> {
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

  const empty: InoRestrictionNoticeResult = {
    to: [], cc: [], restrictionDate: noticeDate(opts.restrictOn), noticeDays: 0,
    overdue: [], upcoming: [], overdueTotal: gbp(0), outstandingTotal: gbp(0),
    attachments: [], sent: false,
  };

  // Nothing overdue means the thing this email threatens would not be justified. Refuse rather
  // than send a notice whose first paragraph is false.
  if (!overdueMonths.length) {
    console.log('[INO-RESTRICT] nothing overdue — no notice to send');
    return empty;
  }

  const overdueTotal = overdueMonths.reduce((s, m) => s + m.total, 0);
  const outstandingTotal = months.reduce((s, m) => s + m.total, 0);
  const earliestOverdue = overdueMonths.reduce((a, b) => (a.due < b.due ? a : b));
  const earliestDue = earliestOverdue.due;
  const daysOverdue = Math.floor((now.getTime() - earliestDue.getTime()) / 864e5);
  const noticeDays = Math.round((opts.restrictOn.getTime() - now.getTime()) / 864e5);

  // Our agreement allows a restriction once an invoice is 30 days unpaid, on 5 days' notice, and
  // the 1 Oct chase quoted that back to them. A date that satisfies it is worth saying out loud;
  // a date that doesn't is worth a warning here rather than an argument with them later.
  const thirtyDayMark = new Date(earliestDue.getTime() + 30 * 864e5);
  const satisfiesTerms = opts.restrictOn >= thirtyDayMark && noticeDays >= TERMS_NOTICE_DAYS;
  const termsNote = satisfiesTerms
    ? `Under our agreement, accounts unpaid after 30 days may have their service restricted on `
      + `${TERMS_NOTICE_DAYS} days' notice; the ${earliestOverdue.subMonthLabel} invoice reaches `
      + '30 days overdue on that date.'
    : undefined;
  if (!satisfiesTerms) {
    console.warn(`[INO-RESTRICT] ⚠️ ${noticeDate(opts.restrictOn)} gives ${noticeDays} days' notice and `
      + `falls ${opts.restrictOn < thirtyDayMark ? 'before' : 'after'} the 30-day mark `
      + `(${prettyDate(thirtyDayMark)}) — our terms are 30 days + ${TERMS_NOTICE_DAYS} days' notice`);
  }

  // Attach only what is overdue. The not-yet-due month is named in the table so they can pay it
  // all at once, but putting its PDF on a restriction notice invites paying the wrong one.
  const attachments: EmailAttachment[] = overdueMonths
    .filter((m) => m.pdf)
    .map((m) => ({
      filename: `ReceptionMate-Invoice-${m.invoiceNo}.pdf`,
      content: m.pdf as Buffer,
      contentType: 'application/pdf',
    }));

  // Dates we have already chased on, so the notice can say so without us retyping them.
  const chased = await prisma.invoice.findMany({
    where: { id: { in: overdueMonths.flatMap((m) => m.ids) } },
    select: { chaseSentAt: true, chase2SentAt: true },
  });
  const remindersSent = [...new Set(
    chased
      .flatMap((c) => [c.chaseSentAt, c.chase2SentAt])
      .filter((d): d is Date => !!d)
      .map((d) => prettyDate(d)),
  )];

  const to = opts.to ?? ['accounts@inocentres.co.uk'];
  const cc = opts.cc ?? ['dan@receptionmate.co.uk'];

  const result: InoRestrictionNoticeResult = {
    to,
    cc,
    restrictionDate: noticeDate(opts.restrictOn),
    noticeDays,
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
  };

  if (opts.dryRun) {
    console.log(`[INO-RESTRICT] dry run — would warn ${to.join(', ')} of a restriction on `
      + `${result.restrictionDate} over ${gbp(overdueTotal)} overdue, ${attachments.length} PDF(s)`);
    return result;
  }

  result.sent = await sendArrearsRestrictionNoticeEmail(to, {
    customerName: "In'n'out Autocentres",
    restrictionDate: result.restrictionDate,
    noticeDays,
    termsNote,
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
    remindersSent,
    portalUrl: process.env.PORTAL_URL || 'https://portal.receptionmate.co.uk',
    attachments,
  }, cc);

  // No chase stamping here on purpose: this is not a chase, and letting it consume a reminder
  // slot would let the nightly job skip the escalation it is still owed.
  console.log(result.sent
    ? `[INO-RESTRICT] notice sent to ${to.join(', ')} — restriction ${result.restrictionDate}`
    : `[INO-RESTRICT] failed to send to ${to.join(', ')}`);
  return result;
}
