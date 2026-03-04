import type { Request, Response } from 'express';
import { Router } from 'express';
import { createRequire } from 'module';
import { prisma } from '../db.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { sendDirectDebitRequestEmail } from '../services/directDebitRequestEmail.js';

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

// POST /api/admin/activate-billing/:userId
router.post('/admin/activate-billing/:userId', authenticate, requireAdmin, async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;

    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Check if user has a GoCardless mandate
    if (!user.gocardlessMandateId) {
      return res.status(400).json({ error: 'User does not have a GoCardless mandate' });
    }

    // Check if billing is already active
    if (user.billingCycleStartDate && user.nextBillingDate) {
      return res.status(400).json({ error: 'Billing is already active for this user' });
    }

    // Get user's garages
    const garages = await prisma.garage.findMany({
      where: {
        id: { in: user.garageAccessIds },
      },
      select: {
        id: true,
        name: true,
        subscriptionCostGbp: true,
        vatRate: true,
        trialEndDate: true,
        requiresBookingActivation: true,
      },
    });

    if (garages.length === 0) {
      return res.status(400).json({ error: 'User has no garage access' });
    }

    const now = new Date();

    // Calculate total subscription cost for active garages
    const activeGarages = garages.filter(g => {
      const inTrial = g.trialEndDate && g.trialEndDate > now;
      const needsActivation = g.requiresBookingActivation;
      return !inTrial && !needsActivation && g.subscriptionCostGbp > 0;
    });

    if (activeGarages.length === 0) {
      return res.status(400).json({
        error: 'No garages ready for billing',
        details: 'All garages are either in trial, require activation, or have £0 subscription cost'
      });
    }

    const totalSubscriptionCost = activeGarages.reduce((sum, g) => sum + g.subscriptionCostGbp, 0);
    // Apply VAT — use the first garage's vatRate (all garages on one mandate share the same rate)
    const vatRate = activeGarages[0]?.vatRate ?? 0.2;
    const vatAmount = totalSubscriptionCost * vatRate;
    const totalIncVat = totalSubscriptionCost + vatAmount;
    const totalInPence = Math.round(totalIncVat * 100);

    // Set billing dates
    const billingCycleStartDate = now;
    const nextBillingDate = new Date(now);
    nextBillingDate.setMonth(nextBillingDate.getMonth() + 1);

    // Charge first month subscription
    let paymentId: string | null = null;
    if (totalInPence > 0) {
      try {
        const client = getGocardlessClient();
        const payment = await client.payments.create({
          amount: totalInPence,
          currency: 'GBP',
          description: `ReceptionMate - First Month Subscription`,
          metadata: {
            user_id: user.id,
            type: 'first_month_subscription',
            activated_by: req.user?.email || 'admin',
          },
          links: {
            mandate: user.gocardlessMandateId,
          },
        });
        paymentId = payment.id;
        console.log(`✅ Activated billing for ${user.email} - Charged £${totalIncVat.toFixed(2)} inc VAT (Payment ID: ${paymentId})`);
      } catch (error) {
        console.error('Failed to charge first month subscription:', error);
        return res.status(500).json({ error: 'Failed to create payment in GoCardless' });
      }
    }

    // Update user with billing dates
    await prisma.user.update({
      where: { id: user.id },
      data: {
        billingCycleStartDate,
        nextBillingDate,
      },
    });

    // Create an invoice record for each active garage
    if (paymentId) {
      const costPerGarage = totalSubscriptionCost / activeGarages.length;
      const vatPerGarage = costPerGarage * vatRate;
      const totalPerGarage = costPerGarage + vatPerGarage;
      for (const garage of activeGarages) {
        await prisma.invoice.create({
          data: {
            garageId: garage.id,
            periodStart: billingCycleStartDate,
            periodEnd: nextBillingDate,
            minutesUsed: 0,
            minutesIncluded: 0,
            smsCount: 0,
            subscriptionAmount: Math.round(costPerGarage * 100),
            minutesAmount: 0,
            smsAmount: 0,
            subtotal: Math.round(costPerGarage * 100),
            vatAmount: Math.round(vatPerGarage * 100),
            total: Math.round(totalPerGarage * 100),
            subscriptionCostGbp: costPerGarage / 100,
            costPerMinuteGbp: 0,
            vatRate,
            status: 'pending',
            gocardlessPaymentId: paymentId,
          },
        });
      }
      console.log(`✅ Created ${activeGarages.length} invoice(s) for payment ${paymentId}`);
    }

    res.json({
      success: true,
      message: 'Billing activated successfully',
      billingCycleStartDate,
      nextBillingDate,
      chargedAmount: totalIncVat,
      chargedAmountExVat: totalSubscriptionCost,
      vatAmount,
      vatRate,
      paymentId,
      garages: activeGarages.map(g => ({ id: g.id, name: g.name, cost: g.subscriptionCostGbp })),
    });
  } catch (error) {
    console.error('Failed to activate billing:', error);
    res.status(500).json({ error: 'Failed to activate billing' });
  }
});

// GET /api/admin/users-pending-billing
router.get('/admin/users-pending-billing', authenticate, requireAdmin, async (req: Request, res: Response) => {
  try {
    // Find users with mandates but no billing dates
    const users = await prisma.user.findMany({
      where: {
        gocardlessMandateId: { not: null },
        billingCycleStartDate: null,
      },
      select: {
        id: true,
        email: true,
        role: true,
        gocardlessMandateId: true,
        gocardlessCustomerId: true,
        garageAccessIds: true,
        createdAt: true,
      },
    });

    // Get garage info for each user
    const usersWithGarages = await Promise.all(
      users.map(async (user) => {
        const garages = await prisma.garage.findMany({
          where: { id: { in: user.garageAccessIds } },
          select: {
            id: true,
            name: true,
            subscriptionCostGbp: true,
            trialEndDate: true,
            requiresBookingActivation: true,
          },
        });

        const now = new Date();
        const activeGarages = garages.filter(g => {
          const inTrial = g.trialEndDate && g.trialEndDate > now;
          const needsActivation = g.requiresBookingActivation;
          return !inTrial && !needsActivation && g.subscriptionCostGbp > 0;
        });

        const totalCost = activeGarages.reduce((sum, g) => sum + g.subscriptionCostGbp, 0);
        const canActivate = activeGarages.length > 0;

        return {
          id: user.id,
          email: user.email,
          role: user.role,
          mandateId: user.gocardlessMandateId,
          createdAt: user.createdAt,
          garages: garages.map(g => ({
            id: g.id,
            name: g.name,
            cost: g.subscriptionCostGbp,
            inTrial: g.trialEndDate && g.trialEndDate > now,
            needsActivation: g.requiresBookingActivation,
          })),
          totalMonthlyCost: totalCost,
          canActivateBilling: canActivate,
        };
      })
    );

    res.json({
      success: true,
      users: usersWithGarages,
    });
  } catch (error) {
    console.error('Failed to get users pending billing:', error);
    res.status(500).json({ error: 'Failed to get users pending billing' });
  }
});

// GET /api/admin/users-without-mandate
router.get('/admin/users-without-mandate', authenticate, requireAdmin, async (req: Request, res: Response) => {
  try {
    // Find users without mandates who have garages assigned
    const users = await prisma.user.findMany({
      where: {
        OR: [
          { gocardlessMandateId: null },
          { gocardlessMandateId: '' },
        ],
        garageAccessIds: {
          isEmpty: false,
        },
      },
      select: {
        id: true,
        email: true,
        role: true,
        garageAccessIds: true,
        createdAt: true,
      },
    });

    // Get garage details for each user
    const usersWithGarages = await Promise.all(
      users.map(async (user) => {
        const garages = await prisma.garage.findMany({
          where: {
            id: { in: user.garageAccessIds },
          },
          select: {
            id: true,
            name: true,
            subscriptionCostGbp: true,
          },
        });

        const totalCost = garages.reduce((sum, g) => sum + g.subscriptionCostGbp, 0);

        return {
          id: user.id,
          email: user.email,
          role: user.role,
          createdAt: user.createdAt,
          garages: garages.map(g => ({
            id: g.id,
            name: g.name,
            cost: g.subscriptionCostGbp,
          })),
          totalMonthlyCost: totalCost,
        };
      })
    );

    res.json({
      success: true,
      users: usersWithGarages,
    });
  } catch (error) {
    console.error('Failed to get users without mandate:', error);
    res.status(500).json({ error: 'Failed to get users without mandate' });
  }
});

// POST /api/admin/request-direct-debit/:userId
router.post('/admin/request-direct-debit/:userId', authenticate, requireAdmin, async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        garageAccessIds: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Get garage details
    const garages = await prisma.garage.findMany({
      where: {
        id: { in: user.garageAccessIds },
      },
      select: {
        name: true,
      },
    });

    const garageNames = garages.map(g => g.name);

    // Send the email
    await sendDirectDebitRequestEmail(user.email, user.email, garageNames);

    res.json({
      success: true,
      message: `Direct Debit request email sent to ${user.email}`,
    });
  } catch (error) {
    console.error('Failed to send Direct Debit request email:', error);
    res.status(500).json({
      error: 'Failed to send Direct Debit request email',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
