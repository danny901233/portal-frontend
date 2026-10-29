// ---------------------------------------------------------------------------
// What a leaver actually owes, and the email that tells them.
// ---------------------------------------------------------------------------
// BILLING IS IN ADVANCE, OVERAGE IS IN ARREARS, AND THE INVOICE LABEL IS THE
// OVERAGE PERIOD. That one sentence is the whole reason this file exists.
//
// An invoice carries `periodStart`/`periodEnd` describing the month whose MINUTES
// are being charged, while the £399 subscription on the same invoice buys the
// month that is about to start. Mallory Performance, read straight off the rows:
//
//   paid 27 Jul   label 20 Jul→20 Aug   subs £399   used   0/400   (signup, no usage yet)
//   paid 21 Aug   label 20 Jul→20 Aug   subs £399   used 285/400
//   paid 21 Sep   label 20 Aug→20 Sep   subs £399   used 275/400
//   paid 21 Oct   label 20 Sep→20 Oct   subs £399   used 207/400
//
// The first two share a label and are NOT duplicates — the usage differs. Reading
// the label as "what this invoice buys" says they paid twice for July and that
// they owe from 20 Oct; both are wrong. The 21 Oct payment bought cover to 20 Nov,
// so a leaver on 26 Nov owes six days, not five weeks. That mistake priced this
// exact account at £574.56 when the true figure was £95.76, on 29 Oct 2026.
//
// So: paidTo = the last PAID invoice's periodEnd, plus one cycle.
//
// REFUSES TO GUESS. Anything this cannot read confidently — no paid invoices, a
// cycle that is not a month, a credit, usage over the allowance — comes back
// `confident: false` with the reason, and the caller shows a human instead of a
// number. A leaving customer who gets a wrong figure disputes it; a leaving
// customer who gets no figure waits a day.
// ---------------------------------------------------------------------------

import { prisma } from '../db.js';

export interface ClosingLine {
  label: string;
  amountPence: number;
}

export interface ClosingAmount {
  confident: boolean;
  /** Why it will not commit to a figure. Empty when confident. */
  blockers: string[];
  garageName: string;
  /** Last day of service — the leaving date. */
  endsOn: Date | null;
  /** When they gave notice. Null when nothing recorded it. */
  noticeGivenOn: Date | null;
  /**
   * Days between notice and the last day of service.
   *
   * Stated to the customer only when it matches the contractual 30 days, because the sentence
   * "your agreement requires 30 days and you gave notice on X, so service ends Y" is a claim
   * about their contract. Where the dates do not add up — notice taken verbally weeks earlier,
   * a date agreed as a favour — the email gives the date and stays quiet about the arithmetic
   * rather than telling a customer something their own paperwork contradicts.
   */
  noticeDays: number | null;
  /** Subscription is paid up to this date. Null when it cannot be established. */
  paidTo: Date | null;
  /** Days of service beyond what is already paid for. */
  chargeableDays: number;
  /** Days in the cycle those are a fraction of. */
  cycleDays: number;
  lines: ClosingLine[];
  subtotalPence: number;
  vatPence: number;
  totalPence: number;
  /** Minutes used since the last billed usage period, against the allowance. */
  minutesUsed: number;
  minutesIncluded: number;
}

// What every agreement version to date requires: "not less than thirty (30) days' written
// notice". Stated here so the email can only ever quote the term the contract actually carries.
const CONTRACT_NOTICE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
const money = (pence: number): string => `£${(pence / 100).toFixed(2)}`;
const theDate = (d: Date): string =>
  d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

/** Whole days between two dates, ignoring the time of day. */
const daysBetween = (from: Date, to: Date): number => {
  const a = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const b = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  return Math.round((b - a) / DAY_MS);
};

/** The same day of the following month, clamped for short months. */
const addMonth = (d: Date): Date => {
  const out = new Date(d);
  const day = out.getUTCDate();
  out.setUTCMonth(out.getUTCMonth() + 1);
  // 31 Jan + 1 month would roll into March; pin it to the last day of February instead.
  if (out.getUTCDate() !== day) out.setUTCDate(0);
  return out;
};

export async function computeClosingAmount(garageId: string): Promise<ClosingAmount> {
  const blockers: string[] = [];
  const garage = await prisma.garage.findUnique({
    where: { id: garageId },
    select: {
      name: true, archiveScheduledAt: true, cancellationRequestedAt: true,
      subscriptionCostGbp: true, vatRate: true, includedMinutes: true, costPerMinuteGbp: true,
    },
  });

  const empty: ClosingAmount = {
    confident: false, blockers, garageName: garage?.name ?? garageId, endsOn: null,
    noticeGivenOn: null, noticeDays: null, paidTo: null,
    chargeableDays: 0, cycleDays: 0, lines: [], subtotalPence: 0, vatPence: 0, totalPence: 0,
    minutesUsed: 0, minutesIncluded: 0,
  };
  if (!garage) { blockers.push('garage not found'); return empty; }

  const endsOn = garage.archiveScheduledAt;
  if (!endsOn) { blockers.push('no leaving date set'); return { ...empty, endsOn: null }; }

  const noticeGivenOn = garage.cancellationRequestedAt ?? null;
  const noticeDays = noticeGivenOn ? daysBetween(noticeGivenOn, endsOn) : null;

  const paidInvoices = await prisma.invoice.findMany({
    where: { garageId, status: 'paid' },
    orderBy: { periodEnd: 'desc' },
    select: { periodStart: true, periodEnd: true, subscriptionAmount: true, minutesUsed: true,
              minutesIncluded: true },
  });
  if (!paidInvoices.length) {
    blockers.push('no paid invoices, so there is nothing to measure "paid up to" from');
    return { ...empty, endsOn, noticeGivenOn: garage.cancellationRequestedAt ?? null };
  }

  const last = paidInvoices[0];
  if (!last.periodEnd || !last.periodStart) {
    blockers.push('the last paid invoice has no billing period on it');
    return { ...empty, endsOn, noticeGivenOn: garage.cancellationRequestedAt ?? null };
  }

  // Advance billing: the subscription on that invoice buys the cycle AFTER the labelled one.
  const paidTo = addMonth(last.periodEnd);
  const cycleDays = daysBetween(last.periodStart, last.periodEnd);
  if (cycleDays < 27 || cycleDays > 32) {
    blockers.push(`the last billing cycle was ${cycleDays} days, which is not a month — `
      + 'the pro rata would be a guess');
  }

  const chargeableDays = Math.max(0, daysBetween(paidTo, endsOn));
  const monthly = Math.round(Number(garage.subscriptionCostGbp || 0) * 100);
  if (!monthly) blockers.push('no monthly subscription recorded');

  const lines: ClosingLine[] = [];
  if (chargeableDays > 0 && cycleDays > 0) {
    lines.push({
      label: `${chargeableDays} day${chargeableDays === 1 ? '' : 's'} of service, `
        + `${theDate(paidTo)} to ${theDate(endsOn)} `
        + `(${chargeableDays}/${cycleDays} of ${money(monthly)})`,
      amountPence: Math.round((monthly * chargeableDays) / cycleDays),
    });
  }

  // Overage for usage not yet billed — everything since the last labelled usage period closed.
  const calls = await prisma.call.findMany({
    where: { garageId, createdAt: { gte: last.periodEnd } },
    select: { durationSeconds: true },
  });
  const minutesUsed = Math.ceil(calls.reduce((a, c) => a + (c.durationSeconds || 0), 0) / 60);
  const minutesIncluded = Number(garage.includedMinutes || 0);
  if (minutesUsed > minutesIncluded) {
    // Deliberately NOT priced automatically. The allowance may be pro-rated for a part month and
    // the answer depends on a policy call, not on arithmetic.
    blockers.push(`${minutesUsed} minutes used against ${minutesIncluded} included — `
      + 'the overage needs pricing by hand');
  }

  const subtotalPence = lines.reduce((a, l) => a + l.amountPence, 0);
  const vatPence = Math.round(subtotalPence * Number(garage.vatRate ?? 0.2));

  return {
    confident: blockers.length === 0,
    blockers,
    garageName: garage.name,
    endsOn,
    noticeGivenOn,
    noticeDays,
    paidTo,
    chargeableDays,
    cycleDays,
    lines,
    subtotalPence,
    vatPence,
    totalPence: subtotalPence + vatPence,
    minutesUsed,
    minutesIncluded,
  };
}

/**
 * The email itself. Two things only, because that is what it was asked to commit to:
 * when service stops and what it stops doing, and the closing figure with its arithmetic
 * shown so it can be checked rather than queried.
 */

/**
 * "You gave notice on X. Your agreement requires 30 days' written notice, so your last day of
 * service is Y." Returned empty unless the dates really do add up to the contractual term —
 * see the note on noticeDays.
 */
function noticeSentence(c: ClosingAmount): string {
  if (!c.noticeGivenOn || !c.endsOn || c.noticeDays === null) return '';
  const exact = c.noticeDays >= CONTRACT_NOTICE_DAYS && c.noticeDays <= CONTRACT_NOTICE_DAYS + 1;
  if (!exact) return '';
  return `You gave notice on ${theDate(c.noticeGivenOn)}, and your agreement asks for `
    + `${CONTRACT_NOTICE_DAYS} days' written notice — one month — so your last day of `
    + `service is ${theDate(c.endsOn)}.`;
}

export function renderLeaverEmail(c: ClosingAmount): { subject: string; html: string; text: string } {
  const endsOn = c.endsOn ? theDate(c.endsOn) : 'the agreed date';
  const notice = noticeSentence(c);
  const rows = c.lines
    .map((l) => `<tr><td style="padding:8px 0;font-size:15px;color:#0f172a;">${l.label}</td>`
      + `<td align="right" style="padding:8px 0;font-size:15px;color:#0f172a;white-space:nowrap;">`
      + `${money(l.amountPence)}</td></tr>`)
    .join('');

  const html = `
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
  <tr><td style="padding:32px 32px 0;">
    <h1 style="margin:0;font-size:21px;font-weight:700;color:#0f172a;line-height:1.3;">Your ReceptionMate account closes on ${endsOn}</h1>
  </td></tr>
  <tr><td style="padding:22px 32px 0;font-size:15px;line-height:1.65;color:#0f172a;">
    <p style="margin:0;">Thanks for letting us know you are moving on. This is just to confirm what happens and what is left to pay, so there are no surprises.</p>
    ${notice ? `<p style="margin:16px 0 0;">${notice}</p>` : ''}
    <p style="margin:16px 0 0;"><strong>On ${endsOn}</strong> your receptionist stops answering calls, and the number we have been answering on is released. Everything works exactly as it does now until then.</p>
  </td></tr>
  <tr><td style="padding:26px 32px 0;">
    <h2 style="margin:0 0 10px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.6px;color:#8b90b0;">Final amount</h2>
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color:#f7f7fb;border:1px solid #e9eaf5;border-radius:10px;">
      <tr><td style="padding:14px 18px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
          ${rows}
          <tr><td colspan="2" style="border-top:1px solid #e9eaf5;padding-top:8px;"></td></tr>
          <tr><td style="padding:4px 0;font-size:14px;color:#64748b;">VAT at 20%</td>
              <td align="right" style="padding:4px 0;font-size:14px;color:#64748b;">${money(c.vatPence)}</td></tr>
          <tr><td style="padding:6px 0 0;font-size:16px;font-weight:700;color:#0f172a;">Total</td>
              <td align="right" style="padding:6px 0 0;font-size:16px;font-weight:700;color:#0f172a;">${money(c.totalPence)}</td></tr>
        </table>
      </td></tr>
    </table>
  </td></tr>
  <tr><td style="padding:18px 32px 0;font-size:15px;line-height:1.65;color:#0f172a;">
    <p style="margin:0;">Your subscription is paid in advance up to <strong>${c.paidTo ? theDate(c.paidTo) : ''}</strong>, so this covers only the days after that up to your closing date${c.minutesUsed <= c.minutesIncluded ? `, and there is nothing to add for call minutes — you used ${c.minutesUsed} of your ${c.minutesIncluded}` : ''}.</p>
  </td></tr>
  <tr><td style="padding:26px 32px 36px;font-size:15px;line-height:1.65;color:#0f172a;">
    <p style="margin:0;">If any of that looks wrong, reply to this email and we will go through it with you.</p>
    <p style="margin:16px 0 0;">Thanks,<br/><strong>The ReceptionMate team</strong></p>
  </td></tr>
</table>`;

  const text = [
    `Your ReceptionMate account closes on ${endsOn}.`,
    '',
    ...(notice ? [notice, ''] : []),
    `On ${endsOn} your receptionist stops answering calls and the number is released.`,
    'Everything works as it does now until then.',
    '',
    'Final amount:',
    ...c.lines.map((l) => `  ${l.label}  ${money(l.amountPence)}`),
    `  VAT at 20%  ${money(c.vatPence)}`,
    `  Total  ${money(c.totalPence)}`,
    '',
    `Your subscription is paid in advance to ${c.paidTo ? theDate(c.paidTo) : ''}, so this covers`,
    'only the days after that up to your closing date.',
    '',
    'If any of that looks wrong, reply and we will go through it with you.',
    '',
    'Thanks,',
    'The ReceptionMate team',
  ].join('\n');

  return { subject: `Your ReceptionMate account closes on ${endsOn}`, html, text };
}
