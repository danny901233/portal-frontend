// Billing watchdog — every account that should be paying should have a PAID invoice each month.
//
// This exists because the failure it catches is silent. Billing selects users whose
// nextBillingDate has come round; a user with NULL nextBillingDate simply never matches, so the
// nightly run reports "no users due for billing" and looks perfectly healthy while a customer goes
// unbilled for months. That is how Eldon Street reached two months and Holmer Green four.
//
// So this checks the OUTCOME, not the process: for every garage that ought to be paying, is there
// a paid invoice in the last month? Anything that isn't gets reported, loudly, every morning until
// it's fixed.
//
// Deliberately excluded: archived (former customers), flagged test accounts, garages still inside
// a trial, and anything with no price set.

import { prisma } from '../db.js';
import { sendEmail } from '../utils/email.js';

const GRACE_DAYS = 35; // a month plus a few days, so a 30th-of-the-month biller isn't flagged early
const STUCK_DAYS = 7;  // an invoice raised but not paid this long is its own problem

export interface BillingGap {
  garageId: string;
  name: string;
  monthlyValue: number;
  lastPaidAt: Date | null;
  daysSince: number | null;
  stuck: string | null; // e.g. 'failed £778.80 on 2026-07-29'
}

export async function findBillingGaps(): Promise<BillingGap[]> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - GRACE_DAYS * 864e5);

  const garages = await prisma.garage.findMany({
    where: {
      archivedAt: null,
      isTestAccount: false,
      OR: [{ subscriptionCostGbp: { gt: 0 } }, { messagingSubscriptionCostGbp: { gt: 0 } }],
    },
    select: {
      id: true, name: true, subscriptionCostGbp: true, messagingSubscriptionCostGbp: true,
      trialEndDate: true, trialEndsAt: true,
    },
  });

  const gaps: BillingGap[] = [];

  for (const g of garages) {
    // Still on trial? Not expected to have paid anything yet.
    const trialEnd = g.trialEndsAt || g.trialEndDate;
    if (trialEnd && trialEnd > now) continue;

    const lastPaid = await prisma.invoice.findFirst({
      where: { garageId: g.id, status: 'paid' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });

    if (lastPaid && lastPaid.createdAt >= cutoff) continue; // paid recently — fine

    // Is there an invoice that exists but never got paid? That's a different fix (chase the
    // payment) from no invoice at all (billing never ran), so name which it is.
    const unpaid = await prisma.invoice.findFirst({
      where: { garageId: g.id, status: { in: ['draft', 'pending', 'failed'] } },
      orderBy: { createdAt: 'desc' },
      select: { status: true, total: true, createdAt: true },
    });

    gaps.push({
      garageId: g.id,
      name: g.name,
      monthlyValue: Number(g.subscriptionCostGbp || 0) + Number(g.messagingSubscriptionCostGbp || 0),
      lastPaidAt: lastPaid?.createdAt ?? null,
      daysSince: lastPaid ? Math.floor((now.getTime() - lastPaid.createdAt.getTime()) / 864e5) : null,
      stuck: unpaid
        ? `${unpaid.status} £${(unpaid.total / 100).toFixed(2)} on ${unpaid.createdAt.toISOString().slice(0, 10)}`
        : null,
    });
  }

  // Worst first: never paid at all, then longest since payment.
  gaps.sort((a, b) => (b.daysSince ?? 9999) - (a.daysSince ?? 9999));
  return gaps;
}

export async function runBillingWatchdog(): Promise<BillingGap[]> {
  const gaps = await findBillingGaps();

  if (gaps.length === 0) {
    console.log('[BILLING_WATCHDOG] every active account has a paid invoice within the last month');
    return gaps;
  }

  const value = gaps.reduce((a, g) => a + g.monthlyValue, 0);
  console.error(`[BILLING_WATCHDOG] ${gaps.length} account(s) with no paid invoice in ${GRACE_DAYS} days — £${value.toFixed(2)}/month`);
  for (const g of gaps) {
    console.error(`[BILLING_WATCHDOG]   ${g.name} — £${g.monthlyValue} — ${g.daysSince === null ? 'NEVER PAID' : g.daysSince + ' days'}${g.stuck ? ` — ${g.stuck}` : ' — no invoice raised'}`);
  }

  const rows = gaps.map((g) => `
    <tr>
      <td style="padding:6px 10px;border-bottom:1px solid #eee">${g.name}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee">£${g.monthlyValue.toFixed(2)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee">${g.daysSince === null ? '<b style="color:#b42318">never paid</b>' : g.daysSince + ' days ago'}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;color:#666">${g.stuck || 'no invoice raised'}</td>
    </tr>`).join('');

  const staff = await prisma.user.findMany({
    where: { role: 'RECEPTIONMATE_STAFF' },
    select: { email: true, notificationEmail: true },
  });
  const to = staff.map((s) => s.notificationEmail || s.email).filter(Boolean);
  if (to.length) {
    await sendEmail({
      to,
      subject: `⚠️ Billing: ${gaps.length} account(s) unpaid this month — £${value.toFixed(0)}/mo`,
      text: `${gaps.length} accounts have no paid invoice in the last ${GRACE_DAYS} days (£${value.toFixed(2)}/month):\n\n`
        + gaps.map((g) => `- ${g.name}: £${g.monthlyValue} — ${g.daysSince === null ? 'NEVER PAID' : g.daysSince + ' days'}${g.stuck ? ` — ${g.stuck}` : ' — no invoice raised'}`).join('\n')
        + `\n\nTrial accounts, test accounts and archived garages are excluded.`,
      html: `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
        <h2 style="margin:0 0 4px;font-size:17px">Accounts with no paid invoice this month</h2>
        <p style="margin:0 0 14px;color:#666;font-size:13px">${gaps.length} account(s) · £${value.toFixed(2)}/month ·
          trials, test accounts and archived garages excluded</p>
        <table style="border-collapse:collapse;font-size:13px">
          <tr><th align="left" style="padding:6px 10px">Garage</th><th align="left" style="padding:6px 10px">Monthly</th>
              <th align="left" style="padding:6px 10px">Last paid</th><th align="left" style="padding:6px 10px">Status</th></tr>
          ${rows}
        </table></div>`,
    });
    console.log(`[BILLING_WATCHDOG] alert emailed to ${to.join(', ')}`);
  }

  return gaps;
}
