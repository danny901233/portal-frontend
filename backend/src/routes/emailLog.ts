// Read side of the email audit trail. Admin-only: the log lists every recipient the portal
// has ever mailed, which is exactly the sort of thing that should not be browsable by a
// garage user who happens to know the URL.
import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
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

type EmailLogRow = {
  id: string;
  to: string[];
  cc: string[];
  subject: string;
  template: string;
  garageId: string | null;
  businessId: string | null;
  userId: string | null;
  pendingSignupId: string | null;
  transport: string;
  status: string;
  error: string | null;
  sentAt: Date;
  deliveredAt: Date | null;
  failedAt: Date | null;
};

/**
 * The search term as a LIKE pattern.
 *
 * Substring, because the question is always "did <person> get it?" and the thing to hand is a
 * name or a domain, not the exact address: this filter used to be an exact match on a whole
 * array element, so searching "mareks" for mareks.kirilovics@garagehive.com returned an empty
 * table that read as "we never emailed him".
 *
 * Wildcards in the term are escaped rather than honoured. A bare "%" would otherwise match
 * every address the portal has ever mailed — the one answer this page must never give wrongly.
 */
export const recipientPattern = (raw: string): string =>
  `%${raw.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * The WHERE clause shared by the page query and its count.
 *
 * Raw SQL rather than a Prisma filter because `to` and `cc` are text[], and Prisma can express
 * only whole-element equality (`has`) on an array column — which is precisely the limitation
 * this is fixing. Every value is still bound as a parameter; nothing is interpolated.
 */
export const emailLogWhere = (filters: {
  to?: string;
  template?: string;
  status?: string;
  garageId?: string;
}): Prisma.Sql => {
  const clauses: Prisma.Sql[] = [];
  if (filters.template) clauses.push(Prisma.sql`template = ${filters.template}`);
  if (filters.status) clauses.push(Prisma.sql`status = ${filters.status}`);
  if (filters.garageId) clauses.push(Prisma.sql`"garageId" = ${filters.garageId}`);
  if (filters.to?.trim()) {
    // cc as well as to: the GarageHive connect request is addressed to them and ccs us, so a
    // search for our own address has to find it.
    clauses.push(Prisma.sql`EXISTS (
      SELECT 1 FROM unnest(coalesce("to", '{}'::text[]) || coalesce(cc, '{}'::text[])) AS addr
       WHERE addr ILIKE ${recipientPattern(filters.to)} ESCAPE '\\'
    )`);
  }
  return clauses.length ? Prisma.join(clauses, ' AND ') : Prisma.sql`TRUE`;
};

router.get('/admin/email-log', authenticate, requireAdmin, async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query', details: parsed.error.flatten() });
  }
  const { to, template, status, garageId, limit, offset } = parsed.data;

  const where = emailLogWhere({ to, template, status, garageId });

  try {
    const [rows, counted] = await Promise.all([
      prisma.$queryRaw<EmailLogRow[]>`
        SELECT id, "to", cc, subject, template,
               "garageId", "businessId", "userId", "pendingSignupId",
               transport, status, error,
               "sentAt", "deliveredAt", "failedAt"
          FROM "EmailLog"
         WHERE ${where}
         ORDER BY "sentAt" DESC
         LIMIT ${limit} OFFSET ${offset}`,
      prisma.$queryRaw<{ total: number }[]>`
        SELECT count(*)::int AS total FROM "EmailLog" WHERE ${where}`,
    ]);
    // count(*) is cast to int in SQL on purpose: a bigint comes back as a BigInt, which
    // res.json then throws on rather than serialising.
    const total = counted[0]?.total ?? 0;

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
