import type { Request, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import gocardless from 'gocardless-nodejs';
import { prisma } from '../db.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

// Initialize GoCardless client
const getGocardlessClient = () => {
  const accessToken = process.env.GOCARDLESS_ACCESS_TOKEN;
  const environment = process.env.GOCARDLESS_ENVIRONMENT || 'sandbox';

  if (!accessToken) {
    throw new Error('GOCARDLESS_ACCESS_TOKEN is not configured');
  }

  const gcEnvironment = environment === 'live'
    ? gocardless.constants.Environments.Live
    : gocardless.constants.Environments.Sandbox;

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

    // Update user with mandate details
    await prisma.user.update({
      where: { id: user.id },
      data: {
        gocardlessMandateId: mandateId,
        gocardlessCustomerId: customerId,
        mustSetupPayment: false,
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

export default router;
