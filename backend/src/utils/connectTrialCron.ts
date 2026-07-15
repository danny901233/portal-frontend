import cron from 'node-cron';
import { prisma } from '../db.js';
import { sendEmail } from './email.js';

// ---------------------------------------------------------------------------
// Connect trial-end watchdog. Runs daily. For Connect-only garages still on the
// free month with no card added (no stripeSubscriptionId):
//   • 7 / 3 / 1 days before trialEndDate → "add your card" reminder email
//   • on/after trialEndDate            → lock the account (accessRestricted=true)
//     so the portal shows the card paywall (see connect-billing.ts + PaymentBlocker)
// Once a card is added the Stripe webhook clears accessRestricted, so locked
// garages naturally drop out of this sweep.
// ---------------------------------------------------------------------------

const PORTAL_URL = process.env.PORTAL_URL || 'https://portal.receptionmate.co.uk';

function reminderHtml(name: string, daysLeft: number): string {
  return `<div style="font-family:Inter,system-ui,sans-serif;max-width:560px;margin:0 auto;color:#0f172a;">
    <h2 style="color:#3426cf;">Your free month ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}</h2>
    <p>Hi ${name},</p>
    <p>Your ReceptionMate Connect free month is nearly up. To keep your AI messaging your customers on WhatsApp, add a card before it ends — it's £250 + VAT a month including 500 conversation credits, and you can cancel anytime.</p>
    <p style="text-align:center;margin:28px 0;"><a href="${PORTAL_URL}/dashboard" style="display:inline-block;background:#3426cf;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;">Add my card</a></p>
    <p style="color:#94a3b8;font-size:13px;">If you don't add a card, your AI will pause when the free month ends — no charge, nothing to cancel.</p>
    <p style="color:#64748b;font-size:13px;">— The ReceptionMate team</p>
  </div>`;
}

function endedHtml(name: string): string {
  return `<div style="font-family:Inter,system-ui,sans-serif;max-width:560px;margin:0 auto;color:#0f172a;">
    <h2 style="color:#3426cf;">Your free month has ended</h2>
    <p>Hi ${name},</p>
    <p>Your ReceptionMate Connect free month is over, so your AI has paused. Add a card to switch it back on — £250 + VAT a month including 500 conversation credits, cancel anytime.</p>
    <p style="text-align:center;margin:28px 0;"><a href="${PORTAL_URL}/dashboard" style="display:inline-block;background:#3426cf;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;">Reactivate my account</a></p>
    <p style="color:#64748b;font-size:13px;">— The ReceptionMate team</p>
  </div>`;
}

async function runConnectTrialCheck(): Promise<void> {
  const now = new Date();
  const garages = await prisma.garage.findMany({
    where: {
      hasVoiceAccess: false,
      hasMessagingAccess: true,
      trialEndDate: { not: null },
      stripeSubscriptionId: null, // no card added yet
    },
    select: {
      id: true, name: true, trialEndDate: true, accessRestricted: true,
      business: { select: { contactEmail: true } },
    },
  });

  for (const g of garages) {
    if (!g.trialEndDate) continue;
    const daysLeft = Math.ceil((g.trialEndDate.getTime() - now.getTime()) / 86_400_000);
    let email = g.business?.contactEmail || null;
    if (!email) {
      const u = await prisma.user.findFirst({ where: { garageAccessIds: { has: g.id } }, select: { email: true } });
      email = u?.email || null;
    }

    if (daysLeft <= 0) {
      if (!g.accessRestricted) {
        await prisma.garage.update({ where: { id: g.id }, data: { accessRestricted: true } });
        if (email) await sendEmail({ to: [email], subject: 'Your ReceptionMate free month has ended', html: endedHtml(g.name), text: `Your free month has ended. Add a card to reactivate: ${PORTAL_URL}/dashboard` }).catch((e) => console.error('[CONNECT_TRIAL] ended email failed', e));
        console.log(`[CONNECT_TRIAL] locked ${g.name} (${g.id})`);
      }
    } else if (daysLeft === 7 || daysLeft === 3 || daysLeft === 1) {
      if (email) await sendEmail({ to: [email], subject: `Your ReceptionMate free month ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`, html: reminderHtml(g.name, daysLeft), text: `Your free month ends in ${daysLeft} day(s). Add a card: ${PORTAL_URL}/dashboard` }).catch((e) => console.error('[CONNECT_TRIAL] reminder email failed', e));
      console.log(`[CONNECT_TRIAL] ${daysLeft}d reminder -> ${g.name}`);
    }
  }
}

export function initConnectTrialCron(): void {
  // Daily at 09:30 UK time (after the existing 09:00 billing jobs).
  cron.schedule('30 9 * * *', () => { void runConnectTrialCheck().catch((e) => console.error('[CONNECT_TRIAL] cron error', e)); }, { timezone: 'Europe/London' });
  console.log('✓ Connect trial-end check scheduled: daily at 9:30 AM (UK time)');
}
