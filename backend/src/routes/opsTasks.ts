// In-portal ops-tasks board for RM staff (Dan + the VA). Shared, Postgres-backed
// so both see the same list. Mirrors the `support.ts` route shape — same auth,
// same error shape, same zod-validated bodies.
//
// Endpoints (all staff-only via requireAdmin):
//   GET    /api/admin/tasks           — list tasks (filters: cadence, status, tag, assigneeId)
//   POST   /api/admin/tasks           — create a task
//   PATCH  /api/admin/tasks/:id       — edit any field (title, instructions, notes, tags, assignee, cadence, dueDate)
//   POST   /api/admin/tasks/:id/toggle — flip status open↔done, set/clear completedAt
//   DELETE /api/admin/tasks/:id       — delete
//   POST   /api/admin/tasks/reset-daily — flip every cadence='daily' task back to open (button in the UI)
//   GET    /api/admin/staff           — list assignable RM staff users for the assignee dropdown

import type { Request, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';

const router = Router();

const cadenceEnum = z.enum(['daily', 'weekly', 'monthly', 'project']);
const statusEnum = z.enum(['open', 'done']);

const createSchema = z.object({
  title: z.string().trim().min(1).max(300),
  instructions: z.string().max(20000).optional().nullable(),
  cadence: cadenceEnum.default('weekly'),
  tags: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  assigneeId: z.string().min(1).nullable().optional(),
  assigneeIds: z.array(z.string().min(1)).max(10).nullable().optional(),
  dueDate: z.string().datetime().nullable().optional(),
});

const patchSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  instructions: z.string().max(20000).nullable().optional(),
  cadence: cadenceEnum.optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  status: statusEnum.optional(),
  notes: z.string().max(20000).nullable().optional(),
  assigneeId: z.string().min(1).nullable().optional(),
  assigneeIds: z.array(z.string().min(1)).max(10).nullable().optional(),
  dueDate: z.string().datetime().nullable().optional(),
  sortOrder: z.number().int().optional(),
});

/**
 * A task can belong to more than one person ("Both" on the board), so assigneeIds is the source
 * of truth. assigneeId is kept in sync with its first entry, which keeps the assignee relation
 * (and any older reader) working without a second concept of ownership.
 *
 * Accepts either field: assigneeIds wins when both are sent; assigneeId alone is treated as a
 * one-person list. Returns null when neither was supplied, so PATCH leaves assignment untouched.
 */
function assignmentData(input: {
  assigneeIds?: string[] | null;
  assigneeId?: string | null;
}): { assigneeIds: string[]; assigneeId: string | null } | null {
  if (input.assigneeIds !== undefined) {
    const ids = [...new Set((input.assigneeIds || []).filter(Boolean))];
    return { assigneeIds: ids, assigneeId: ids[0] ?? null };
  }
  if (input.assigneeId !== undefined) {
    const ids = input.assigneeId ? [input.assigneeId] : [];
    return { assigneeIds: ids, assigneeId: input.assigneeId ?? null };
  }
  return null;
}

// Same include shape everywhere so the frontend gets consistent rows
const taskInclude = {
  assignee: { select: { id: true, email: true } },
  createdBy: { select: { id: true, email: true } },
} as const;

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

router.get('/admin/tasks', authenticate, requireAdmin, async (req: Request, res: Response) => {
  const cadence = typeof req.query.cadence === 'string' ? req.query.cadence : undefined;
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const assigneeId = typeof req.query.assigneeId === 'string' ? req.query.assigneeId : undefined;
  const tag = typeof req.query.tag === 'string' ? req.query.tag : undefined;

  const where: Record<string, unknown> = {};
  if (cadence && cadenceEnum.safeParse(cadence).success) where.cadence = cadence;
  if (status && statusEnum.safeParse(status).success) where.status = status;
  if (assigneeId) where.assigneeIds = { has: assigneeId };
  if (tag) where.tags = { has: tag };

  const tasks = await prisma.opsTask.findMany({
    where,
    orderBy: [{ cadence: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
    include: taskInclude,
    take: 500,
  });
  return res.json({ tasks });
});

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

router.post('/admin/tasks', authenticate, requireAdmin, async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorised' });
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
  }

  const task = await prisma.opsTask.create({
    data: {
      title: parsed.data.title,
      instructions: parsed.data.instructions ?? null,
      cadence: parsed.data.cadence,
      tags: parsed.data.tags,
      ...(assignmentData(parsed.data) ?? { assigneeIds: [], assigneeId: null }),
      dueDate: parsed.data.dueDate ? new Date(parsed.data.dueDate) : null,
      createdById: req.user.userId,
    },
    include: taskInclude,
  });
  return res.status(201).json({ task });
});

// ---------------------------------------------------------------------------
// Patch (edit any field)
// ---------------------------------------------------------------------------

router.patch('/admin/tasks/:id', authenticate, requireAdmin, async (req: Request, res: Response) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
  }

  const existing = await prisma.opsTask.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Task not found' });

  // Build the update payload, only setting fields that were actually sent
  const data: Record<string, unknown> = {};
  if (parsed.data.title !== undefined) data.title = parsed.data.title;
  if (parsed.data.instructions !== undefined) data.instructions = parsed.data.instructions;
  if (parsed.data.cadence !== undefined) data.cadence = parsed.data.cadence;
  if (parsed.data.tags !== undefined) data.tags = parsed.data.tags;
  if (parsed.data.notes !== undefined) data.notes = parsed.data.notes;
  const assignment = assignmentData(parsed.data);
  if (assignment) Object.assign(data, assignment);
  if (parsed.data.dueDate !== undefined) {
    data.dueDate = parsed.data.dueDate ? new Date(parsed.data.dueDate) : null;
  }
  if (parsed.data.sortOrder !== undefined) data.sortOrder = parsed.data.sortOrder;

  // If status is changing, sync completedAt too
  if (parsed.data.status !== undefined) {
    data.status = parsed.data.status;
    if (parsed.data.status === 'done' && existing.status !== 'done') {
      data.completedAt = new Date();
    } else if (parsed.data.status === 'open') {
      data.completedAt = null;
    }
  }

  const task = await prisma.opsTask.update({
    where: { id: req.params.id },
    data,
    include: taskInclude,
  });
  return res.json({ task });
});

// ---------------------------------------------------------------------------
// Toggle open↔done (checkbox click — cheap and idempotent-per-click)
// ---------------------------------------------------------------------------

router.post('/admin/tasks/:id/toggle', authenticate, requireAdmin, async (req: Request, res: Response) => {
  const existing = await prisma.opsTask.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Task not found' });

  const nextStatus = existing.status === 'done' ? 'open' : 'done';
  const task = await prisma.opsTask.update({
    where: { id: existing.id },
    data: {
      status: nextStatus,
      completedAt: nextStatus === 'done' ? new Date() : null,
    },
    include: taskInclude,
  });
  return res.json({ task });
});

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

router.delete('/admin/tasks/:id', authenticate, requireAdmin, async (req: Request, res: Response) => {
  const existing = await prisma.opsTask.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Task not found' });
  await prisma.opsTask.delete({ where: { id: existing.id } });
  return res.json({ success: true });
});

// ---------------------------------------------------------------------------
// Reset every daily task back to 'open' — the "start of day" button.
// A cron can be added later; for v1 this is manual.
// ---------------------------------------------------------------------------

router.post('/admin/tasks/reset-daily', authenticate, requireAdmin, async (_req: Request, res: Response) => {
  const result = await prisma.opsTask.updateMany({
    where: { cadence: 'daily', status: 'done' },
    data: { status: 'open', completedAt: null },
  });
  return res.json({ reopened: result.count });
});

// ---------------------------------------------------------------------------
// Staff dropdown source — who can be assigned
// ---------------------------------------------------------------------------

router.get('/admin/staff', authenticate, requireAdmin, async (_req: Request, res: Response) => {
  const staff = await prisma.user.findMany({
    where: { role: 'RECEPTIONMATE_STAFF' },
    select: { id: true, email: true },
    orderBy: { email: 'asc' },
  });
  return res.json({ staff });
});

export default router;
