import type { Request, Response } from 'express';
import { Router } from 'express';
import crypto from 'crypto';
import { prisma } from '../../db.js';

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

  // You can add payment tracking logic here if needed
  // For now, we just log payment events
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
