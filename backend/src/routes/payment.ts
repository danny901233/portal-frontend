import type { Request, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { createRequire } from 'module';
import { prisma } from '../db.js';
import { authenticate } from '../middleware/auth.js';

const require = createRequire(import.meta.url);
const gocardless = require('gocardless-nodejs');
const constants = require('gocardless-nodejs/constants');

const router = Router();

// Initialize GoCardless client
const getGocardlessClient = () => {
  const accessToken = process.env.GOCARDLESS_ACCESS_TOKEN;
  const environment = process.env.GOCARDLESS_ENVIRONMENT || 'sandbox';

  if (!accessToken) {
    throw new Error('GOCARDLESS_ACCESS_TOKEN is not configured');
  }

  const gcEnvironment = environment === 'live'
    ? constants.Environments.Live
    : constants.Environments.Sandbox;

  return gocardless(accessToken, gcEnvironment);
};

// POST /api/payment/create-mandate-flow
router.post('/payment/create-mandate-flow', authenticate, async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const client = getGocardlessClient();
    const portalUrl = process.env.PORTAL_URL || 'https://portal.receptionmate.co.uk';

    // Create redirect flow with GoCardless
    const redirectFlow = await client.redirectFlows.create({
      description: 'ReceptionMate Monthly Subscription',
      session_token: user.id,
      success_redirect_url: `${portalUrl}/setup-payment/callback`,
      prefilled_customer: {
        email: user.email,
      },
    });

    res.json({
      success: true,
      redirectUrl: redirectFlow.redirect_url,
      redirectFlowId: redirectFlow.id,
    });
  } catch (error) {
    console.error('Failed to create mandate flow:', error);
    res.status(500).json({ error: 'Failed to initiate payment setup' });
  }
});

// POST /api/payment/confirm-mandate
router.post('/payment/confirm-mandate', authenticate, async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const schema = z.object({
      redirectFlowId: z.string().min(1),
    });

    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: 'Invalid request', details: result.error.flatten() });
    }

    const { redirectFlowId } = result.data;

    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const client = getGocardlessClient();

    // Complete the redirect flow
    const completedFlow = await client.redirectFlows.complete(redirectFlowId, {
      session_token: user.id,
    });

    const mandateId = completedFlow.links.mandate;
    const customerId = completedFlow.links.customer;

    // Verify the mandate is active
    const mandate = await client.mandates.find(mandateId);

    if (mandate.status !== 'pending_customer_approval' && mandate.status !== 'pending_submission' && mandate.status !== 'submitted' && mandate.status !== 'active') {
      return res.status(400).json({ error: 'Mandate is not in a valid state' });
    }

    const now = new Date();

    // Check if any garages have trial or activation requirements
    const garages = await prisma.garage.findMany({
      where: {
        id: { in: user.garageAccessIds },
      },
      select: {
        id: true,
        name: true,
        businessId: true,
        subscriptionCostGbp: true,
        includedMinutes: true,
        costPerMinuteGbp: true,
        vatRate: true,
        trialEndDate: true,
        requiresBookingActivation: true,
      },
    });

    // Belt-and-braces: set billing dates whenever the user has at least one garage
    // that isn't gated by trial/booking-activation — regardless of whether the
    // subscription cost is non-zero yet. Historically, gating on `subscriptionCostGbp > 0`
    // here meant any customer who completed Direct Debit before the admin finished
    // pricing-config (Speedy Spanners, VRS Midlands) ended up with billingCycleStartDate
    // and nextBillingDate permanently null and invisible to the scheduler. Onboarding
    // now requires pricing up-front, but this widened guard ensures any future edge case
    // still gets a billing cycle assigned.
    const hasBillableGarage = garages.some(g => {
      const inTrial = g.trialEndDate && g.trialEndDate > now;
      const needsActivation = g.requiresBookingActivation;
      return !inTrial && !needsActivation;
    });

    // Separate flag for whether to actually charge the first month — only true when
    // there's at least one garage with a real subscription cost.
    const hasActiveGarages = garages.some(g => {
      const inTrial = g.trialEndDate && g.trialEndDate > now;
      const needsActivation = g.requiresBookingActivation;
      return !inTrial && !needsActivation && g.subscriptionCostGbp > 0;
    });

    let billingCycleStartDate: Date | null = null;
    let nextBillingDate: Date | null = null;

    if (hasBillableGarage) {
      billingCycleStartDate = now;
      nextBillingDate = new Date(now);
      nextBillingDate.setMonth(nextBillingDate.getMonth() + 1);
    }

    if (hasActiveGarages) {

      // Generate first invoices for active garages
      const activeGarages = garages.filter(g => {
        const inTrial = g.trialEndDate && g.trialEndDate > now;
        const needsActivation = g.requiresBookingActivation;
        return !inTrial && !needsActivation && g.subscriptionCostGbp > 0;
      });

      const invoices = [];

      // Create invoice for each active garage
      for (const garage of activeGarages) {
        // First month: Charge subscription in advance (no usage yet)
        const subscriptionAmount = Math.round(garage.subscriptionCostGbp * 100);
        const minutesAmount = 0; // No usage yet
        const smsAmount = 0; // No SMS yet
        const subtotal = subscriptionAmount;
        const vatAmount = Math.round(subtotal * garage.vatRate);
        const total = subtotal + vatAmount;

        const invoice = await prisma.invoice.create({
          data: {
            garageId: garage.id,
            businessId: garage.businessId,
            userId: user.id,
            periodStart: now,
            periodEnd: nextBillingDate!,
            minutesUsed: 0,
            minutesIncluded: garage.includedMinutes,
            smsCount: 0,
            subscriptionAmount,
            minutesAmount,
            smsAmount,
            subtotal,
            vatAmount,
            total,
            subscriptionCostGbp: garage.subscriptionCostGbp,
            costPerMinuteGbp: garage.costPerMinuteGbp,
            vatRate: garage.vatRate,
            status: 'draft',
          },
        });

        invoices.push({ invoice, garage, total });
      }

      // Create ONE combined payment for all invoices
      if (invoices.length > 0) {
        const totalAmount = invoices.reduce((sum, item) => sum + item.total, 0);

        try {
          const payment = await client.payments.create({
            amount: totalAmount,
            currency: 'GBP',
            description: `ReceptionMate - First Month (${invoices.length} branch${invoices.length > 1 ? 'es' : ''})`,
            metadata: {
              user_id: user.id,
              type: 'first_month_subscription',
              invoice_count: invoices.length.toString(),
              billing_cycle_start: now.toISOString(),
            },
            links: {
              mandate: mandateId,
            },
          });

          // Update all invoices with payment ID
          for (const item of invoices) {
            await prisma.invoice.update({
              where: { id: item.invoice.id },
              data: {
                status: 'pending',
                gocardlessPaymentId: payment.id,
              },
            });
          }

          const breakdown = invoices.map(item =>
            `${item.garage.name}: £${(item.total / 100).toFixed(2)}`
          ).join(', ');

          console.log(`✓ First month invoices created for ${user.email}: £${(totalAmount / 100).toFixed(2)} (${invoices.length} branches)`);
          console.log(`  Breakdown: ${breakdown}`);
          console.log(`  Payment ID: ${payment.id}`);
        } catch (error) {
          console.error('Failed to charge first month subscription:', error);
        }
      }
    } else {
      console.log(`User ${user.email} has trial/activation requirements - billing will start when activated`);
    }

    // Update user with mandate details and billing cycle dates
    await prisma.user.update({
      where: { id: user.id },
      data: {
        gocardlessMandateId: mandateId,
        gocardlessCustomerId: customerId,
        mustSetupPayment: false,
        billingCycleStartDate: billingCycleStartDate,
        nextBillingDate: nextBillingDate,
      },
    });

    res.json({
      success: true,
      message: 'Payment setup completed successfully',
      mandateId,
    });
  } catch (error) {
    console.error('Failed to confirm mandate:', error);
    res.status(500).json({ error: 'Failed to confirm payment setup' });
  }
});

// GET /api/payment/mandate-status
router.get('/payment/mandate-status', authenticate, async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: {
        gocardlessMandateId: true,
        mustSetupPayment: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const hasMandate = !!user.gocardlessMandateId && !user.mustSetupPayment;

    res.json({
      success: true,
      hasMandate,
      mandateId: user.gocardlessMandateId || undefined,
      requiresSetup: user.mustSetupPayment,
    });
  } catch (error) {
    console.error('Failed to get mandate status:', error);
    res.status(500).json({ error: 'Failed to get payment status' });
  }
});

// POST /api/payment/update-mandate-flow
router.post('/payment/update-mandate-flow', authenticate, async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: {
        id: true,
        email: true,
        gocardlessMandateId: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!user.gocardlessMandateId) {
      return res.status(400).json({ error: 'No existing mandate to update' });
    }

    const client = getGocardlessClient();
    const portalUrl = process.env.PORTAL_URL || 'https://portal.receptionmate.co.uk';

    // Create new redirect flow for mandate update
    const redirectFlow = await client.redirectFlows.create({
      description: 'ReceptionMate - Update Payment Method',
      session_token: `${user.id}-update-${Date.now()}`,
      success_redirect_url: `${portalUrl}/billing/update-payment-callback`,
      prefilled_customer: {
        email: user.email,
      },
    });

    res.json({
      success: true,
      redirectUrl: redirectFlow.redirect_url,
      redirectFlowId: redirectFlow.id,
    });
  } catch (error) {
    console.error('Failed to create mandate update flow:', error);
    res.status(500).json({ error: 'Failed to initiate mandate update' });
  }
});

// POST /api/payment/confirm-mandate-update
router.post('/payment/confirm-mandate-update', authenticate, async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const schema = z.object({
      redirectFlowId: z.string().min(1),
    });

    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: 'Invalid request', details: result.error.flatten() });
    }

    const { redirectFlowId } = result.data;

    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: {
        id: true,
        gocardlessMandateId: true,
        gocardlessCustomerId: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const oldMandateId = user.gocardlessMandateId;
    const client = getGocardlessClient();

    // Complete the redirect flow to get new mandate
    const completedFlow = await client.redirectFlows.complete(redirectFlowId, {
      session_token: `${user.id}-update-${redirectFlowId}`,
    });

    const newMandateId = completedFlow.links.mandate;
    const newCustomerId = completedFlow.links.customer;

    // Cancel old mandate if exists
    if (oldMandateId) {
      try {
        await client.mandates.cancel(oldMandateId);
        console.log(`Cancelled old mandate ${oldMandateId} for user ${user.id}`);
      } catch (error) {
        console.error('Failed to cancel old mandate:', error);
        // Continue anyway - new mandate is active
      }
    }

    // Update user with new mandate
    await prisma.user.update({
      where: { id: user.id },
      data: {
        gocardlessMandateId: newMandateId,
        gocardlessCustomerId: newCustomerId,
        mustSetupPayment: false,
      },
    });

    console.log(`Updated mandate for user ${user.id}: ${oldMandateId} → ${newMandateId}`);

    res.json({
      success: true,
      message: 'Payment method updated successfully',
      mandateId: newMandateId,
    });
  } catch (error) {
    console.error('Failed to confirm mandate update:', error);
    res.status(500).json({ error: 'Failed to complete mandate update' });
  }
});

export default router;
