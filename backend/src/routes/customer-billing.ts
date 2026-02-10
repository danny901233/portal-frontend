import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth.js';
import { prisma } from '../db.js';
import { generateInvoicePdf } from '../services/invoicePdf.js';
import { isManagerForGarage } from '../utils/branchRoles.js';

const router = Router();

/**
 * Middleware to ensure user is a manager of at least one garage
 */
function requireManager(req: Request, res: Response, next: Function) {
  const branchRoles = req.user?.branchRoles || {};
  const isManager = Object.values(branchRoles).some((role) => role === 'MANAGER');

  if (!isManager && req.user?.role !== 'ADMIN' && req.user?.role !== 'RECEPTIONMATE_STAFF') {
    return res.status(403).json({ error: 'Manager access required' });
  }

  next();
}

/**
 * Get user's managed garage IDs
 */
function getManagedGarageIds(req: Request): string[] {
  if (req.user?.role === 'ADMIN' || req.user?.role === 'RECEPTIONMATE_STAFF') {
    // Admins and staff see all garages they have access to
    return req.user.garageIds || [];
  }

  const branchRoles = req.user?.branchRoles || {};
  return Object.entries(branchRoles)
    .filter(([, role]) => role === 'MANAGER')
    .map(([garageId]) => garageId);
}

/**
 * GET /api/customer/billing/invoices
 * List invoices for user's managed garages
 * Query params: garageId (optional - filter to specific garage)
 */
router.get('/invoices', authenticate, requireManager, async (req: Request, res: Response) => {
  try {
    const { garageId } = req.query;
    const managedGarageIds = getManagedGarageIds(req);

    if (managedGarageIds.length === 0) {
      return res.json({ invoices: [] });
    }

    // If garageId specified, validate user manages it
    if (garageId && typeof garageId === 'string') {
      if (!managedGarageIds.includes(garageId)) {
        return res.status(403).json({ error: 'Access denied to this garage' });
      }
    }

    // Build query
    const where: any = {
      garageId: garageId
        ? garageId
        : { in: managedGarageIds },
    };

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
      orderBy: {
        createdAt: 'desc',
      },
    });

    res.json({ invoices });
  } catch (error) {
    console.error('Error fetching invoices:', error);
    res.status(500).json({ error: 'Failed to fetch invoices' });
  }
});

/**
 * GET /api/customer/billing/invoices/:invoiceId/pdf
 * Download invoice as PDF
 */
router.get('/invoices/:invoiceId/pdf', authenticate, requireManager, async (req: Request, res: Response) => {
  try {
    const { invoiceId } = req.params;

    // Fetch invoice to check garage access
    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: {
        id: true,
        garageId: true,
        garage: {
          select: {
            name: true,
          },
        },
      },
    });

    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    // Validate user manages this garage
    const managedGarageIds = getManagedGarageIds(req);
    if (!managedGarageIds.includes(invoice.garageId)) {
      return res.status(403).json({ error: 'Access denied to this invoice' });
    }

    // Generate PDF
    const pdfBuffer = await generateInvoicePdf(invoiceId);

    // Send as download
    const filename = `invoice-${invoice.id.slice(0, 8)}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.send(pdfBuffer);
  } catch (error) {
    console.error('Error generating PDF:', error);
    res.status(500).json({ error: 'Failed to generate PDF' });
  }
});

/**
 * GET /api/customer/billing/business-info
 * Get business billing information for user's business
 */
router.get('/business-info', authenticate, requireManager, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Get user to find their business
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        garageAccessIds: true,
      },
    });

    if (!user || user.garageAccessIds.length === 0) {
      return res.status(404).json({ error: 'No garages found for user' });
    }

    // Get first garage to find business
    const garage = await prisma.garage.findUnique({
      where: { id: user.garageAccessIds[0] },
      select: {
        businessId: true,
      },
    });

    if (!garage || !garage.businessId) {
      return res.status(404).json({ error: 'No business found' });
    }

    // Fetch business info
    const business = await prisma.business.findUnique({
      where: { id: garage.businessId },
      select: {
        id: true,
        name: true,
        billingAddress: true,
        billingCity: true,
        billingPostcode: true,
        billingCountry: true,
        vatNumber: true,
        companyRegNumber: true,
        billingEmail: true,
        billingInfoUpdatedAt: true,
      },
    });

    if (!business) {
      return res.status(404).json({ error: 'Business not found' });
    }

    res.json({ business });
  } catch (error) {
    console.error('Error fetching business info:', error);
    res.status(500).json({ error: 'Failed to fetch business information' });
  }
});

/**
 * PUT /api/customer/billing/business-info
 * Update business billing information
 */
router.put('/business-info', authenticate, requireManager, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const {
      billingAddress,
      billingCity,
      billingPostcode,
      billingCountry,
      vatNumber,
      companyRegNumber,
      billingEmail,
    } = req.body;

    // Get user's business
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        garageAccessIds: true,
      },
    });

    if (!user || user.garageAccessIds.length === 0) {
      return res.status(404).json({ error: 'No garages found for user' });
    }

    const garage = await prisma.garage.findUnique({
      where: { id: user.garageAccessIds[0] },
      select: {
        businessId: true,
      },
    });

    if (!garage || !garage.businessId) {
      return res.status(404).json({ error: 'No business found' });
    }

    // Update business
    const business = await prisma.business.update({
      where: { id: garage.businessId },
      data: {
        billingAddress,
        billingCity,
        billingPostcode,
        billingCountry,
        vatNumber,
        companyRegNumber,
        billingEmail,
        billingInfoUpdatedAt: new Date(),
      },
      select: {
        id: true,
        name: true,
        billingAddress: true,
        billingCity: true,
        billingPostcode: true,
        billingCountry: true,
        vatNumber: true,
        companyRegNumber: true,
        billingEmail: true,
        billingInfoUpdatedAt: true,
      },
    });

    res.json({ business });
  } catch (error) {
    console.error('Error updating business info:', error);
    res.status(500).json({ error: 'Failed to update business information' });
  }
});

/**
 * GET /api/customer/billing/mandate-status?garageId=xxx
 * Get Direct Debit mandate status for the selected branch's business
 */
router.get('/mandate-status', authenticate, requireManager, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { garageId } = req.query;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        garageAccessIds: true,
        role: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Determine which garage to check
    let targetGarageId: string | null = null;

    if (garageId && typeof garageId === 'string') {
      // Use the provided garageId
      targetGarageId = garageId;
    } else {
      // Get user's garages
      let garageIds = user.garageAccessIds || [];
      if (user.role === 'RECEPTIONMATE_STAFF') {
        // Staff have access to all garages
        const allGarages = await prisma.garage.findMany({ select: { id: true } });
        garageIds = allGarages.map(g => g.id);
      }

      if (garageIds.length === 0) {
        return res.json({
          hasMandate: false,
          status: 'none',
          mandateId: null,
          customerId: null,
          nextBillingDate: null,
        });
      }

      targetGarageId = garageIds[0];
    }

    // Get business ID from the target garage
    const garage = await prisma.garage.findUnique({
      where: { id: targetGarageId },
      select: { businessId: true },
    });

    if (!garage?.businessId) {
      return res.json({
        hasMandate: false,
        status: 'none',
        mandateId: null,
        customerId: null,
        nextBillingDate: null,
      });
    }

    // Find ANY user with a mandate for this business's garages
    const garagesInBusiness = await prisma.garage.findMany({
      where: { businessId: garage.businessId },
      select: { id: true },
    });

    const businessGarageIds = garagesInBusiness.map(g => g.id);

    // Find any user with access to these garages who has a mandate
    // NOTE: We only check users who have access to this business's garages
    // Staff users are not considered here - mandate must be set up by actual business users
    const userWithMandate = await prisma.user.findFirst({
      where: {
        garageAccessIds: { hasSome: businessGarageIds },
        gocardlessMandateId: { not: null },
      },
      select: {
        gocardlessMandateId: true,
        gocardlessCustomerId: true,
        nextBillingDate: true,
      },
    });

    const hasMandate = !!userWithMandate?.gocardlessMandateId;
    const mandateStatus = hasMandate ? 'active' : 'none';

    res.json({
      hasMandate,
      status: mandateStatus,
      mandateId: userWithMandate?.gocardlessMandateId || null,
      customerId: userWithMandate?.gocardlessCustomerId || null,
      nextBillingDate: userWithMandate?.nextBillingDate || null,
    });
  } catch (error) {
    console.error('Error fetching mandate status:', error);
    res.status(500).json({ error: 'Failed to fetch mandate status' });
  }
});

export default router;
