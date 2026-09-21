// Read side of the email audit trail. Admin-only: the log lists every recipient the portal
// has ever mailed, which is exactly the sort of thing that should not be browsable by a
// garage user who happens to know the URL.
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';

const router = Router();

const querySchema = z.object({
  // Substring match against a recipient address. The common support question is "did
  // <person> get it?", so recipient is the primary axis rather than date.
  to: z.string().trim().min(1).max(200).optional(),
  template: z.string().trim().max(100).optional(),
  status: z.string().trim().max(40).optional(),
  garageId: z.string().trim().max(100).optional(),
  // Page size stays modest: each row carries an address array and a subject.
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

router.get('/admin/email-log', authenticate, requireAdmin, async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query', details: parsed.error.flatten() });
  }
  const { to, template, status, garageId, limit, offset } = parsed.data;

  const where = {
    ...(template ? { template } : {}),
    ...(status ? { status } : {}),
    ...(garageId ? { garageId } : {}),
    // `to` is a string[]; `has` is an exact element match, so fall back to a raw-ish
    // contains via `hasSome` on the trimmed input. Exact address is the realistic lookup —
    // support is pasting an address, not guessing a fragment.
    ...(to ? { to: { has: to.toLowerCase() } } : {}),
  };

  try {
    const [rows, total] = await Promise.all([
      prisma.emailLog.findMany({
        where,
        orderBy: { sentAt: 'desc' },
        take: limit,
        skip: offset,
        select: {
          id: true, to: true, cc: true, subject: true, template: true,
          garageId: true, businessId: true, userId: true, pendingSignupId: true,
          transport: true, status: true, error: true,
          sentAt: true, deliveredAt: true, failedAt: true,
        },
      }),
      prisma.emailLog.count({ where }),
    ]);

    return res.json({ rows, total, limit, offset, hasMore: offset + rows.length < total });
  } catch (error) {
    console.error('[EMAIL_LOG] query failed:', error);
    return res.status(500).json({ error: 'Failed to load email log' });
  }
});

/** Distinct template tags actually present, so the UI filter lists what exists rather than
 *  a hardcoded list that drifts every time a sender is added. */
router.get('/admin/email-log/templates', authenticate, requireAdmin, async (_req, res) => {
  try {
    const rows = await prisma.emailLog.groupBy({
      by: ['template'],
      _count: { template: true },
      orderBy: { _count: { template: 'desc' } },
    });
    return res.json({
      templates: rows.map((r) => ({ template: r.template, count: r._count.template })),
    });
  } catch (error) {
    console.error('[EMAIL_LOG] template list failed:', error);
    return res.status(500).json({ error: 'Failed to load templates' });
  }
});

export default router;
