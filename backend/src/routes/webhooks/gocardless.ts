import type { Request, Response } from 'express';
import { Router } from 'express';
import crypto from 'crypto';
import { prisma } from '../../db.js';
import { markBusinessNeedsMandate } from '../../utils/businessBilling.js';
import { sendPaymentFailedEmail } from '../../utils/email.js';
import { createPaymentSetupLink } from '../../services/directDebitRequestEmail.js';

const router = Router();

// GoCardless webhook secret - should be set when configuring webhook in GoCardless dashboard
const WEBHOOK_SECRET = process.env.GOCARDLESS_WEBHOOK_SECRET || '';

/**
 * Verify GoCardless webhook signature
 * GoCardless sends a Webhook-Signature header with HMAC-SHA256 signature
 */
function verifyWebhookSignature(payload: string, signature: string): boolean {
  if (!WEBHOOK_SECRET) {
    console.warn('GOCARDLESS_WEBHOOK_SECRET not configured - webhook verification disabled');
    return true; // Allow in development, but warn
  }

  const expectedSignature = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(payload)
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

/**
 * Put every garage this user pays for into arrears, unless it is already counting down.
 *
 * Only touches garages where this user is the payer — a manager with access to a branch someone
 * else pays for must not drag it into arrears. Existing paymentFailedAt values are preserved so
 * a second event can't keep pushing the grace period back.
 */
async function startArrearsForMandateHolder(userId: string, reason: string) {
  const payer = await prisma.user.findUnique({
    where: { id: userId },
    select: { garageAccessIds: true },
  });
  if (!payer?.garageAccessIds?.length) return;

  const res = await prisma.garage.updateMany({
    where: {
      id: { in: payer.garageAccessIds },
      archivedAt: null,
      paymentFailedAt: null,
    },
    data: { paymentFailedAt: new Date() },
  });
  if (res.count > 0) {
    console.warn(`[GoCardless] ⚠️ ${res.count} garage(s) now in arrears — ${reason}`);
  }
}

/**
 * Handle mandate status changes
 */
async function handleMandateEvent(event: any) {
  const { action, resource_type } = event;

  if (resource_type !== 'mandates') {
    return; // Not a mandate event
  }

  const mandate = event.links?.mandate;
  if (!mandate) {
    console.error('Mandate event missing mandate ID:', event);
    return;
  }

  console.log(`[GoCardless Webhook] Mandate ${action}: ${mandate}`);

  // Find user by mandate ID
  const user = await prisma.user.findFirst({
    where: { gocardlessMandateId: mandate },
  });

  if (!user) {
    console.warn(`No user found for mandate ${mandate}`);
    return;
  }

  // Handle different mandate actions
  switch (action) {
    case 'cancelled':
    case 'failed':
    case 'expired':
      // Mandate is no longer valid - require user to set up payment again
      await prisma.user.update({
        where: { id: user.id },
        data: {
          mustSetupPayment: true,
          gocardlessMandateId: null,
          gocardlessCustomerId: null,
        },
      });
      // ...and start the arrears clock on the garages this mandate pays for. Without this the
      // flag above only nags one user: paymentFailedAt stays null, so the grace period never
      // starts, accessRestricted never flips, and the garage keeps receiving full call summaries
      // for a subscription that can no longer be collected. A cancelled mandate is a payment
      // failure that simply hasn't been attempted yet — treat it as one.
      await startArrearsForMandateHolder(user.id, `mandate ${action}`);
      // Raise the prompt on the business so ANY of their users can re-authorise, and clear the
      // dead id so nothing can try to bill against it.
      await markBusinessNeedsMandate(user.garageAccessIds as string[] | null, `mandate ${action}`);
      console.log(`[GoCardless] User ${user.email} mandate ${action} - payment setup required`);
      break;

    case 'created':
    case 'submitted':
    case 'active':
      // Mandate is active - ensure user doesn't need to set up payment
      if (user.mustSetupPayment) {
        await prisma.user.update({
          where: { id: user.id },
          data: { mustSetupPayment: false },
        });
        console.log(`[GoCardless] User ${user.email} mandate ${action} - payment setup complete`);
      }
      break;

    case 'customer_approval_granted':
    case 'customer_approval_skipped':
      // Approval steps - no action needed
      console.log(`[GoCardless] Mandate ${mandate} approval: ${action}`);
      break;

    default:
      console.log(`[GoCardless] Unhandled mandate action: ${action}`);
  }
}

/**
 * Handle payment status changes
 */
async function handlePaymentEvent(event: any) {
  const { action, resource_type } = event;

  if (resource_type !== 'payments') {
    return;
  }

  const paymentId = event.links?.payment;
  console.log(`[GoCardless Webhook] Payment ${action}: ${paymentId}`);
  if (!paymentId) {
    return;
  }

  // Match the GoCardless payment back to the invoice it was raised for (the payment id is stored on
  // the invoice when the Direct Debit charge is created). GC payment ids ("PM…") never collide with
  // the Stripe session ids that also live in this column ("cs_…"), so this lookup is safe.
  const invoice = await prisma.invoice.findFirst({ where: { gocardlessPaymentId: paymentId } });
  if (!invoice) {
    console.log(`[GoCardless Webhook] No invoice matched payment ${paymentId} (action=${action})`);
    return;
  }

  if (action === 'confirmed' || action === 'paid_out') {
    if (invoice.status !== 'paid') {
      await prisma.invoice.update({
        where: { id: invoice.id },
        data: { status: 'paid', paidAt: new Date() },
      });
      console.log(`[GoCardless Webhook] Invoice ${invoice.id} marked PAID (payment ${action})`);
    }
    // Recovered: clear the arrears clock so access and full call details are restored.
    const garage = await prisma.garage.findUnique({
      where: { id: invoice.garageId }, select: { paymentFailedAt: true },
    });
    if (garage?.paymentFailedAt) {
      await prisma.garage.update({
        where: { id: invoice.garageId },
        data: { paymentFailedAt: null, accessRestricted: false },
      });
      console.log(`[GoCardless Webhook] Garage ${invoice.garageId} out of arrears — payment received`);
    }
  } else if (action === 'failed' || action === 'charged_back' || action === 'late_failure_settled') {
    await prisma.invoice.update({ where: { id: invoice.id }, data: { status: 'failed' } });
    console.log(`[GoCardless Webhook] Invoice ${invoice.id} marked FAILED (payment ${action})`);

    // Start the arrears clock. Without this a bounced Direct Debit was recorded on the invoice and
    // NOWHERE else: paymentFailedAt stayed null, so the grace period never started, the garage was
    // never restricted, and the customer was never told. Caldwell & Dempster bounced on 30 June and
    // took 79 more calls before anyone noticed — in August, by hand.
    //
    // Only stamp if not already set, so a second failure does not restart the grace period and
    // give a non-paying account another two days.
    const garage = await prisma.garage.findUnique({
      where: { id: invoice.garageId }, select: { paymentFailedAt: true, name: true },
    });
    if (garage && !garage.paymentFailedAt) {
      await prisma.garage.update({
        where: { id: invoice.garageId }, data: { paymentFailedAt: new Date() },
      });
      console.warn(`[GoCardless Webhook] ⚠️ ${garage.name} payment ${action} — arrears clock started`);

      // Tell them. Until now a bounced Direct Debit was silent on the customer's side — they had
      // no idea anything had failed, and neither did we.
      void (async () => {
        try {
          const cfg = await prisma.agentConfiguration.findUnique({
            where: { garageId: invoice.garageId },
            select: { notificationEmails: true, branchName: true },
          });
          const to = cfg?.notificationEmails?.length ? cfg.notificationEmails : [];
          if (!to.length) return;
          const user = await prisma.user.findFirst({
            where: { garageAccessIds: { has: invoice.garageId } },
            select: { email: true, gocardlessMandateId: true },
          });
          // If the mandate is gone we cannot retry, so the email has to ask them to re-authorise.
          const mandateDead = !user?.gocardlessMandateId;
          let ddSetupUrl: string | undefined;
          if (mandateDead && user?.email) {
            try { ddSetupUrl = await createPaymentSetupLink(user.email); } catch { /* no portal user */ }
          }
          await sendPaymentFailedEmail(to, {
            branchName: cfg?.branchName || garage.name,
            amount: `£${(invoice.total / 100).toFixed(2)}`,
            retryDays: 4,
            mandateDead,
            ddSetupUrl,
          });
          console.log(`[GoCardless Webhook] payment-failed email sent to ${to.join(', ')}`);
        } catch (e: any) {
          console.error('[GoCardless Webhook] could not send payment-failed email:', e?.message);
        }
      })();
    } else {
      console.warn(`[GoCardless Webhook] ⚠️ ${garage?.name} payment ${action} — already in arrears since ${garage?.paymentFailedAt?.toISOString().slice(0,10)}`);
    }
  } else if (action === 'cancelled') {
    await prisma.invoice.update({ where: { id: invoice.id }, data: { status: 'cancelled' } });
    console.log(`[GoCardless Webhook] Invoice ${invoice.id} marked CANCELLED (payment ${action})`);
  } else {
    console.log(`[GoCardless Webhook] Payment ${action} for invoice ${invoice.id} — no status change`);
  }
}

// POST /api/webhooks/gocardless - Receive GoCardless webhook events
router.post('/gocardless', async (req: Request, res: Response) => {
  try {
    // Get webhook signature from header
    const signature = req.headers['webhook-signature'] as string;

    if (!signature && WEBHOOK_SECRET) {
      console.error('Missing webhook signature');
      return res.status(401).json({ error: 'Missing signature' });
    }

    // Get raw body for signature verification
    const rawBody = JSON.stringify(req.body);

    // Verify signature
    if (signature && !verifyWebhookSignature(rawBody, signature)) {
      console.error('Invalid webhook signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const { events } = req.body;

    if (!events || !Array.isArray(events)) {
      console.error('Invalid webhook payload:', req.body);
      return res.status(400).json({ error: 'Invalid payload' });
    }

    console.log(`[GoCardless Webhook] Received ${events.length} event(s)`);

    // Process each event
    for (const event of events) {
      try {
        const { resource_type } = event;

        switch (resource_type) {
          case 'mandates':
            await handleMandateEvent(event);
            break;
          case 'payments':
            await handlePaymentEvent(event);
            break;
          default:
            console.log(`[GoCardless] Unhandled resource type: ${resource_type}`);
        }
      } catch (error) {
        console.error('Error processing webhook event:', error);
        // Continue processing other events
      }
    }

    // Always return 200 to acknowledge receipt
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('GoCardless webhook error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

export default router;
