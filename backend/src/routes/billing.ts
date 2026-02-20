import type { Request, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import {
  calculateUsage,
  calculateBilling,
  generateInvoice,
  generateInvoicesForPeriod,
  createPaymentForInvoice,
  findUsersDueForBilling,
  generateInvoicesForUser,
  processMonthlyBilling,
} from '../services/billing.js';

const router = Router();

// Middleware to check if user is RECEPTIONMATE_STAFF
const requireStaff = (req: Request, res: Response, next: any) => {
  if (req.user?.role !== 'RECEPTIONMATE_STAFF') {
    return res.status(403).json({ error: 'Access denied - staff only' });
  }
  next();
};

// GET /api/billing/garages/:garageId/config - Get billing configuration
router.get(
  '/billing/garages/:garageId/config',
  authenticate,
  requireStaff,
  async (req: Request, res: Response) => {
    try {
      const { garageId } = req.params;

      const garage = await prisma.garage.findUnique({
        where: { id: garageId },
        select: {
          id: true,
          name: true,
          subscriptionCostGbp: true,
          includedMinutes: true,
          costPerMinuteGbp: true,
          vatRate: true,
          trialEndDate: true,
          requiresBookingActivation: true,
          bookingsRequiredForActivation: true,
          activationBookingsCount: true,
          subscriptionActivatedAt: true,
        },
      });

      if (!garage) {
        return res.status(404).json({ error: 'Garage not found' });
      }

      res.json({ success: true, config: garage });
    } catch (error) {
      console.error('Failed to fetch billing config:', error);
      res.status(500).json({ error: 'Failed to fetch billing configuration' });
    }
  }
);

// PUT /api/billing/garages/:garageId/config - Update billing configuration
router.put(
  '/billing/garages/:garageId/config',
  authenticate,
  requireStaff,
  async (req: Request, res: Response) => {
    try {
      const { garageId } = req.params;

      const schema = z.object({
        subscriptionCostGbp: z.number().min(0),
        includedMinutes: z.number().int().min(0),
        costPerMinuteGbp: z.number().min(0),
        vatRate: z.number().min(0).max(1),
        trialDays: z.number().int().min(0).optional(),
        requiresBookingActivation: z.boolean().optional(),
        bookingsRequiredForActivation: z.number().int().min(1).optional(),
      });

      const result = schema.safeParse(req.body);
      if (!result.success) {
        return res.status(400).json({ error: 'Invalid request', details: result.error.flatten() });
      }

      const { trialDays, ...billingData } = result.data;

      // Calculate trialEndDate from trialDays
      const updateData: any = { ...billingData };
      if (trialDays !== undefined) {
        if (trialDays > 0) {
          const trialEndDate = new Date();
          trialEndDate.setDate(trialEndDate.getDate() + trialDays);
          updateData.trialEndDate = trialEndDate;
        } else {
          updateData.trialEndDate = null;
        }
      }

      const garage = await prisma.garage.update({
        where: { id: garageId },
        data: updateData,
      });

      res.json({ success: true, config: garage });
    } catch (error) {
      console.error('Failed to update billing config:', error);
      res.status(500).json({ error: 'Failed to update billing configuration' });
    }
  }
);

// GET /api/billing/garages/:garageId/usage - Calculate current usage
router.get(
  '/billing/garages/:garageId/usage',
  authenticate,
  requireStaff,
  async (req: Request, res: Response) => {
    try {
      const { garageId } = req.params;
      const { startDate, endDate } = req.query;

      if (!startDate || !endDate) {
        return res.status(400).json({ error: 'startDate and endDate required' });
      }

      const periodStart = new Date(startDate as string);
      const periodEnd = new Date(endDate as string);

      const usage = await calculateUsage(garageId, periodStart, periodEnd);
      const billing = await calculateBilling(garageId, usage);

      res.json({
        success: true,
        usage,
        billing,
      });
    } catch (error) {
      console.error('Failed to calculate usage:', error);
      res.status(500).json({ error: 'Failed to calculate usage' });
    }
  }
);

// POST /api/billing/invoices/generate - Generate invoice for a garage
router.post(
  '/billing/invoices/generate',
  authenticate,
  requireStaff,
  async (req: Request, res: Response) => {
    try {
      const schema = z.object({
        garageId: z.string(),
        periodStart: z.string(),
        periodEnd: z.string(),
      });

      const result = schema.safeParse(req.body);
      if (!result.success) {
        return res.status(400).json({ error: 'Invalid request', details: result.error.flatten() });
      }

      const { garageId, periodStart, periodEnd } = result.data;

      const invoice = await generateInvoice(
        garageId,
        new Date(periodStart),
        new Date(periodEnd)
      );

      res.json({ success: true, invoice });
    } catch (error) {
      console.error('Failed to generate invoice:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to generate invoice'
      });
    }
  }
);

// POST /api/billing/invoices/generate-batch - Generate invoices for all garages
router.post(
  '/billing/invoices/generate-batch',
  authenticate,
  requireStaff,
  async (req: Request, res: Response) => {
    try {
      const schema = z.object({
        periodStart: z.string(),
        periodEnd: z.string(),
      });

      const result = schema.safeParse(req.body);
      if (!result.success) {
        return res.status(400).json({ error: 'Invalid request', details: result.error.flatten() });
      }

      const { periodStart, periodEnd } = result.data;

      const results = await generateInvoicesForPeriod(
        new Date(periodStart),
        new Date(periodEnd)
      );

      const successCount = results.filter((r) => r.success).length;
      const failureCount = results.filter((r) => !r.success).length;

      res.json({
        success: true,
        summary: {
          total: results.length,
          succeeded: successCount,
          failed: failureCount,
        },
        results,
      });
    } catch (error) {
      console.error('Failed to generate batch invoices:', error);
      res.status(500).json({ error: 'Failed to generate invoices' });
    }
  }
);

// GET /api/billing/invoices - List all invoices
router.get(
  '/billing/invoices',
  authenticate,
  requireStaff,
  async (req: Request, res: Response) => {
    try {
      const { garageId, status, limit = '50' } = req.query;

      const where: any = {};
      if (garageId) where.garageId = garageId;
      if (status) where.status = status;

      const invoices = await prisma.invoice.findMany({
        where,
        include: {
          garage: {
            select: {
              id: true,
              name: true,
            },
          },
        },
        orderBy: { periodStart: 'desc' },
        take: parseInt(limit as string),
      });

      res.json({ success: true, invoices });
    } catch (error) {
      console.error('Failed to fetch invoices:', error);
      res.status(500).json({ error: 'Failed to fetch invoices' });
    }
  }
);

// GET /api/billing/invoices/:invoiceId - Get single invoice
router.get(
  '/billing/invoices/:invoiceId',
  authenticate,
  requireStaff,
  async (req: Request, res: Response) => {
    try {
      const { invoiceId } = req.params;

      const invoice = await prisma.invoice.findUnique({
        where: { id: invoiceId },
        include: {
          garage: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      });

      if (!invoice) {
        return res.status(404).json({ error: 'Invoice not found' });
      }

      res.json({ success: true, invoice });
    } catch (error) {
      console.error('Failed to fetch invoice:', error);
      res.status(500).json({ error: 'Failed to fetch invoice' });
    }
  }
);

// POST /api/billing/invoices/:invoiceId/charge - Create GoCardless payment
router.post(
  '/billing/invoices/:invoiceId/charge',
  authenticate,
  requireStaff,
  async (req: Request, res: Response) => {
    const { invoiceId } = req.params;
    
    try {
      console.log('[BILLING] Creating payment for invoice:', invoiceId);

      const result = await createPaymentForInvoice(invoiceId);

      console.log('[BILLING] Payment created successfully:', {
        invoiceId,
        paymentId: result.payment.id,
        amount: result.payment.amount,
      });

      res.json({
        success: true,
        invoice: result.invoice,
        payment: {
          id: result.payment.id,
          amount: result.payment.amount,
          status: result.payment.status,
        },
      });
    } catch (error) {
      console.error('[BILLING] Failed to create payment for invoice:', invoiceId);
      console.error('[BILLING] Error details:', {
        message: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
        error,
      });
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to create payment',
      });
    }
  }
);

// GET /api/billing/users-due - Get users due for billing
router.get(
  '/billing/users-due',
  authenticate,
  requireStaff,
  async (req: Request, res: Response) => {
    try {
      const users = await findUsersDueForBilling();

      // Fetch garage details for each user
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

          return {
            ...user,
            garages: garages.filter(g => g.subscriptionCostGbp > 0),
          };
        })
      );

      res.json({ success: true, users: usersWithGarages });
    } catch (error) {
      console.error('Failed to fetch users due for billing:', error);
      res.status(500).json({ error: 'Failed to fetch users due for billing' });
    }
  }
);

// POST /api/billing/process-monthly - Process monthly billing for all users due
router.post(
  '/billing/process-monthly',
  authenticate,
  requireStaff,
  async (req: Request, res: Response) => {
    try {
      const result = await processMonthlyBilling();

      res.json({
        success: true,
        summary: {
          processed: result.processed,
          successful: result.successful,
          failed: result.failed,
        },
        results: result.results,
      });
    } catch (error) {
      console.error('Failed to process monthly billing:', error);
      res.status(500).json({ error: 'Failed to process monthly billing' });
    }
  }
);

// POST /api/billing/users/:userId/generate-invoices - Generate invoices for a specific user
router.post(
  '/billing/users/:userId/generate-invoices',
  authenticate,
  requireStaff,
  async (req: Request, res: Response) => {
    try {
      const { userId } = req.params;

      const result = await generateInvoicesForUser(userId);

      res.json({ success: true, ...result });
    } catch (error) {
      console.error('Failed to generate invoices for user:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to generate invoices',
      });
    }
  }
);

export default router;
