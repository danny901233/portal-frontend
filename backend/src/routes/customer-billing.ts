import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth.js';
import { prisma } from '../db.js';
import { generateInvoicePdf, generateCombinedInvoicePdf, combinedInvoiceNumber } from '../services/invoicePdf.js';
import { isManagerForGarage } from '../utils/branchRoles.js';
import {
  sendInvoiceCopies,
  invoiceCopiesSentInLastHour,
  HOURLY_SEND_LIMIT,
  EMAIL_RE,
} from '../services/invoiceCopies.js';

const router = Router();

/**
 * Middleware to ensure user is a manager of at least one garage
 */
function requireManager(req: Request, res: Response, next: Function) {
  const branchRoles = req.user?.branchRoles || {};
  const isManager = Object.values(branchRoles).some((role) => role === 'MANAGER');

  if (!isManager && req.user?.role !== 'MANAGER' && req.user?.role !== 'RECEPTIONMATE_STAFF') {
    return res.status(403).json({ error: 'Manager access required' });
  }

  next();
}

/**
 * Get user's managed garage IDs
 */
function getManagedGarageIds(req: Request): string[] {
  if (req.user?.role === 'MANAGER' || req.user?.role === 'RECEPTIONMATE_STAFF') {
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

    // Build query. A business on combined invoicing is billed as one, so picking a branch must
    // not hide the rest of the invoice they are charged for — widen back to the whole business.
    let scopeGarageIds: string[] = garageId && typeof garageId === 'string' ? [garageId] : managedGarageIds;
    if (garageId && typeof garageId === 'string') {
      const picked = await prisma.garage.findUnique({
        where: { id: garageId },
        select: { businessId: true, business: { select: { combinedInvoicing: true } } },
      });
      if (picked?.business?.combinedInvoicing && picked.businessId) {
        const siblings = await prisma.garage.findMany({
          where: { businessId: picked.businessId, id: { in: managedGarageIds } },
          select: { id: true },
        });
        scopeGarageIds = siblings.map((g) => g.id);
      }
    }
    const where: any = { garageId: { in: scopeGarageIds } };

    const invoices = await prisma.invoice.findMany({
      where,
      include: {
        garage: {
          select: {
            id: true,
            name: true,
            businessId: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    res.json({ invoices: await combineWhereAsked(invoices, managedGarageIds) });
  } catch (error) {
    console.error('Error fetching invoices:', error);
    res.status(500).json({ error: 'Failed to fetch invoices' });
  }
});


/**
 * Roll a business's per-branch invoices into the one invoice the customer is actually charged.
 *
 * The Direct Debit was already a single combined collection; only the paperwork was split, so a
 * two-branch customer saw two documents for one payment and no total anywhere matched their bank
 * statement. Businesses opt in with `combinedInvoicing`, so no existing customer's invoices
 * change shape mid-contract.
 *
 * The per-branch rows are untouched underneath — arrears, chasing and reconciliation still read
 * them. This is a view, not a second source of truth.
 */
type InvoiceWithGarage = Awaited<ReturnType<typeof prisma.invoice.findMany>>[number] & {
  garage: { id: string; name: string; businessId: string | null };
};

const COMBINED_PREFIX = 'cmb_';

/** `cmb_<businessId>_<periodStart ms>` — enough to re-find the group, and obvious in a log. */
function combinedId(businessId: string, periodStart: Date): string {
  const day = new Date(periodStart);
  day.setHours(0, 0, 0, 0);
  return `${COMBINED_PREFIX}${businessId}_${day.getTime()}`;
}

function parseCombinedId(id: string): { businessId: string; periodStart: Date } | null {
  if (!id.startsWith(COMBINED_PREFIX)) return null;
  const rest = id.slice(COMBINED_PREFIX.length);
  const split = rest.lastIndexOf('_');
  if (split <= 0) return null;
  const ms = Number(rest.slice(split + 1));
  if (!Number.isFinite(ms)) return null;
  return { businessId: rest.slice(0, split), periodStart: new Date(ms) };
}

async function combineWhereAsked(invoices: InvoiceWithGarage[], managedGarageIds: string[]) {
  const businessIds = [...new Set(invoices.map((i) => i.garage.businessId).filter(Boolean))] as string[];
  if (businessIds.length === 0) return invoices;

  const combining = new Set(
    (await prisma.business.findMany({
      where: { id: { in: businessIds }, combinedInvoicing: true },
      select: { id: true },
    })).map((b) => b.id),
  );
  if (combining.size === 0) return invoices;

  const out: unknown[] = [];
  // period -> the branch invoices that make it up, per business.
  const groups = new Map<string, InvoiceWithGarage[]>();
  for (const inv of invoices) {
    const businessId = inv.garage.businessId;
    if (!businessId || !combining.has(businessId)) {
      out.push(inv);
      continue;
    }
    const key = combinedId(businessId, inv.periodStart);
    const group = groups.get(key);
    if (group) group.push(inv);
    else groups.set(key, [inv]);
  }

  for (const [id, group] of groups) {
    const parsed = parseCombinedId(id)!;
    // A branch the viewer does not manage still belongs on the invoice they are charged for,
    // but they must not be shown a total they cannot see the parts of.
    const visible = group.filter((i) => managedGarageIds.includes(i.garageId));
    if (visible.length === 0) continue;
    // Nothing to combine: a single-branch business (or a viewer who manages one branch of it)
    // keeps the ordinary invoice, named after its branch rather than "All branches (1)".
    if (visible.length === 1) {
      out.push(visible[0]);
      continue;
    }
    const sum = (pick: (i: InvoiceWithGarage) => number) => visible.reduce((t, i) => t + pick(i), 0);
    const newest = visible.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
    const statuses = new Set(visible.map((i) => i.status.toLowerCase()));
    out.push({
      ...newest,
      id,
      combined: true,
      invoiceNumber: combinedInvoiceNumber(parsed.businessId, parsed.periodStart),
      branchCount: visible.length,
      branches: visible.map((i) => ({ id: i.garageId, name: i.garage.name, total: i.total })),
      garage: { id: '', name: `All branches (${visible.length})` },
      minutesUsed: sum((i) => i.minutesUsed),
      minutesIncluded: sum((i) => i.minutesIncluded),
      smsCount: sum((i) => i.smsCount),
      subscriptionAmount: sum((i) => i.subscriptionAmount),
      messagingSubscriptionAmount: sum((i) => i.messagingSubscriptionAmount),
      minutesAmount: sum((i) => i.minutesAmount),
      smsAmount: sum((i) => i.smsAmount),
      subtotal: sum((i) => i.subtotal),
      vatAmount: sum((i) => i.vatAmount),
      total: sum((i) => i.total),
      // One collection: the group is only paid when every branch is, and one failure fails it.
      status: statuses.has('failed')
        ? 'failed'
        : statuses.has('pending')
          ? 'pending'
          : statuses.has('draft')
            ? 'draft'
            : 'paid',
    });
  }

  return out.sort((a, b) => {
    const at = new Date((a as { createdAt: Date }).createdAt).getTime();
    const bt = new Date((b as { createdAt: Date }).createdAt).getTime();
    return bt - at;
  });
}

/**
 * POST /api/customer/billing/invoices/email
 *
 * Email the customer copies of invoices they picked, so getting hold of their own billing
 * history does not require asking us for it. Body: { invoiceIds: string[], alsoTo?: string }.
 *
 * The primary recipient is always the signed-in user's own address, read from the database
 * rather than taken from the request — a client that could name its own "to" would turn this
 * into an open relay for PDFs from our sending domain. `alsoTo` is the real-world case: garages
 * forward invoices to whoever does their books.
 */
router.post('/invoices/email', authenticate, requireManager, async (req: Request, res: Response) => {
  try {
    const { invoiceIds, alsoTo } = req.body ?? {};

    if (!Array.isArray(invoiceIds) || invoiceIds.length === 0 || !invoiceIds.every((i) => typeof i === 'string')) {
      return res.status(400).json({ error: 'Select at least one invoice' });
    }
    // A cap on one request, so a single call cannot try to render hundreds of PDFs.
    if (invoiceIds.length > 24) {
      return res.status(400).json({ error: 'Too many invoices in one email — select 24 or fewer' });
    }

    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (!user?.email) return res.status(400).json({ error: 'Your account has no email address' });

    if (alsoTo !== undefined && alsoTo !== null && alsoTo !== '') {
      if (typeof alsoTo !== 'string' || !EMAIL_RE.test(alsoTo.trim())) {
        return res.status(400).json({ error: 'That second email address is not valid' });
      }
    }

    // Authorisation: every invoice must belong to a garage this user manages. Done here, by id,
    // rather than trusting the ids the page happened to render.
    const managedGarageIds = getManagedGarageIds(req);
    if (managedGarageIds.length === 0) {
      return res.status(403).json({ error: 'No garages to send invoices for' });
    }
    // A combined invoice is not a row in the table — it is the whole business's bill for that
    // period, which is the document a combined-invoicing customer actually recognises. Separate
    // them out and authorise each against the business, mirroring the PDF download route.
    const plainIds: string[] = [];
    const combinedPicks: { businessId: string; periodStart: Date; label: string; total: number }[] = [];
    for (const id of invoiceIds as string[]) {
      const parsed = parseCombinedId(id);
      if (parsed) {
        const managesThisBusiness = await prisma.garage.findFirst({
          where: { id: { in: managedGarageIds }, businessId: parsed.businessId },
          select: { id: true },
        });
        if (!managesThisBusiness) {
          return res.status(403).json({ error: 'Access denied to one or more of those invoices' });
        }
        const dayStart = new Date(parsed.periodStart);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(dayStart);
        dayEnd.setDate(dayEnd.getDate() + 1);
        const parts = await prisma.invoice.findMany({
          where: {
            garage: { businessId: parsed.businessId },
            periodStart: { gte: dayStart, lt: dayEnd },
            status: { not: 'cancelled' },
          },
          select: { total: true, periodStart: true, periodEnd: true },
        });
        if (parts.length === 0) {
          return res.status(404).json({ error: 'One or more of those invoices no longer exists' });
        }
        combinedPicks.push({
          businessId: parsed.businessId,
          periodStart: parsed.periodStart,
          label: `${parts[0].periodStart.toLocaleDateString('en-GB')} – ${parts[0].periodEnd.toLocaleDateString('en-GB')} (all branches)`,
          total: parts.reduce((a, b) => a + b.total, 0),
        });
      } else {
        plainIds.push(id);
      }
    }

    const invoices = await prisma.invoice.findMany({
      where: { id: { in: plainIds } },
      select: { id: true, garageId: true },
    });
    if (invoices.length !== plainIds.length) {
      return res.status(404).json({ error: 'One or more of those invoices no longer exists' });
    }
    const outOfScope = invoices.filter((inv) => !managedGarageIds.includes(inv.garageId));
    if (outOfScope.length > 0) {
      console.warn(`[INVOICE_COPIES] ${req.user?.email} asked for ${outOfScope.length} invoice(s) outside their scope`);
      return res.status(403).json({ error: 'Access denied to one or more of those invoices' });
    }

    const recentSends = await invoiceCopiesSentInLastHour(userId);
    if (recentSends >= HOURLY_SEND_LIMIT) {
      return res.status(429).json({ error: 'That is a lot of invoice emails in one hour. Try again later.' });
    }

    const to = [user.email];
    const second = typeof alsoTo === 'string' ? alsoTo.trim() : '';
    if (second && second.toLowerCase() !== user.email.toLowerCase()) to.push(second);

    const result = await sendInvoiceCopies({
      invoiceIds: invoices.map((i) => i.id),
      combined: combinedPicks,
      to,
      requestedByUserId: userId,
    });

    if (!result.sent) {
      console.error(`[INVOICE_COPIES] self-serve send failed for ${user.email}: ${result.reason}`);
      return res.status(400).json(result);
    }

    console.log(`[INVOICE_COPIES] ${user.email} emailed ${result.invoiceCount} invoice(s) to ${to.join(', ')}`);
    res.json(result);
  } catch (error) {
    console.error('Error emailing invoice copies:', error);
    res.status(500).json({ error: 'Failed to email those invoices' });
  }
});

/**
 * GET /api/customer/billing/invoices/:invoiceId/pdf
 * Download invoice as PDF
 */
router.get('/invoices/:invoiceId/pdf', authenticate, requireManager, async (req: Request, res: Response) => {
  try {
    const { invoiceId } = req.params;
    const managedGarageIds = getManagedGarageIds(req);

    // A combined invoice is the whole business's bill for that period, not a row in the table.
    const combined = parseCombinedId(invoiceId);
    if (combined) {
      const managesThisBusiness = await prisma.garage.findFirst({
        where: { id: { in: managedGarageIds }, businessId: combined.businessId },
        select: { id: true },
      });
      if (!managesThisBusiness) {
        return res.status(403).json({ error: 'Access denied to this invoice' });
      }
      const pdf = await generateCombinedInvoicePdf(combined.businessId, combined.periodStart);
      const name = combinedInvoiceNumber(combined.businessId, combined.periodStart);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${name}.pdf"`);
      res.setHeader('Content-Length', pdf.length);
      return res.send(pdf);
    }

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

    const requestedGarageId = req.query.garageId as string | undefined;

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

    // Use requested garageId if provided and allowed, otherwise fall back to first
    const resolvedGarageId =
      requestedGarageId && (req.user?.role === 'RECEPTIONMATE_STAFF' || user.garageAccessIds.includes(requestedGarageId))
        ? requestedGarageId
        : user.garageAccessIds[0];

    // Get garage to find business
    const garage = await prisma.garage.findUnique({
      where: { id: resolvedGarageId },
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
      garageId: requestedGarageId,
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

    const resolvedGarageId =
      requestedGarageId && (req.user?.role === 'RECEPTIONMATE_STAFF' || user.garageAccessIds.includes(requestedGarageId))
        ? requestedGarageId
        : user.garageAccessIds[0];

    const garage = await prisma.garage.findUnique({
      where: { id: resolvedGarageId },
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
