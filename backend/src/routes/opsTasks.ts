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
//   GET    /api/admin/reports         — list stored end-of-day reports (newest first)
//   GET    /api/admin/reports/:date   — one report, 'YYYY-MM-DD'
//   POST   /api/admin/reports/run     — build/store/email a report now (defaults to today)

import type { Request, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { runDailyReport, ukDateString } from '../services/opsDailyReport.js';
import { notifyTaskAssignees } from '../services/opsNotify.js';

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
  priority: z.enum(['normal', 'urgent']).optional(),
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
  priority: z.enum(['normal', 'urgent']).optional(),
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
      priority: parsed.data.priority ?? 'normal',
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
  if (parsed.data.priority !== undefined) data.priority = parsed.data.priority;
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
  if (!req.user) return res.status(401).json({ error: 'Unauthorised' });
  const existing = await prisma.opsTask.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Task not found' });

  const nextStatus = existing.status === 'done' ? 'open' : 'done';
  const completedAt = new Date();
  const task = await prisma.opsTask.update({
    where: { id: existing.id },
    data: {
      status: nextStatus,
      completedAt: nextStatus === 'done' ? completedAt : null,
      completedById: nextStatus === 'done' ? req.user.userId : null,
    },
    include: taskInclude,
  });

  // Write the permanent record. The task's own completedAt is wiped by the daily reset, so this
  // log is the only thing that survives to be reported on. Never blocks the toggle.
  if (nextStatus === 'done') {
    prisma.opsTaskCompletion.create({
      data: {
        taskId: existing.id,
        taskTitle: existing.title,
        cadence: existing.cadence,
        tags: existing.tags,
        completedById: req.user.userId,
        completedAt,
        notes: existing.notes,
      },
    }).catch((e: any) => console.error("[OPS_COMPLETION] failed to log completion", e?.message));
  }

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

router.post('/admin/tasks/reset-daily', authenticate, requireAdmin, async (req: Request, res: Response) => {
  // Manual version of the automatic reset (services/opsTaskReset). Defaults to 'daily' so the
  // existing button keeps working; accepts a cadence for weekly/monthly.
  const requested = typeof req.body?.cadence === 'string' ? req.body.cadence : 'daily';
  const cadence = ['daily', 'weekly', 'monthly'].includes(requested) ? requested : 'daily';
  const result = await prisma.opsTask.updateMany({
    where: { cadence, status: 'done' },
    data: { status: 'open', completedAt: null, completedById: null },
  });
  return res.json({ reopened: result.count });
});

// ---------------------------------------------------------------------------
// Internal: another service raises a task (e.g. mmh-api when documents are uploaded)
//
// Token-gated rather than user-authenticated, because the caller is a machine. Deliberately
// narrow: title, optional detail-free note, assignee, priority, tags. It is idempotent on
// dedupeKey so a webhook retry cannot create the same task twice.
// ---------------------------------------------------------------------------

const internalTaskSchema = z.object({
  title: z.string().trim().min(1).max(300),
  instructions: z.string().max(4000).optional(),
  assigneeEmail: z.string().email().optional(),
  priority: z.enum(['normal', 'urgent']).default('normal'),
  cadence: cadenceEnum.default('project'),
  tags: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  dedupeKey: z.string().max(200).optional(),
});

router.post('/internal/ops-task', async (req: Request, res: Response) => {
  const expected = process.env.INTERNAL_TASK_TOKEN;
  const supplied = req.get('x-internal-token');
  if (!expected || !supplied || supplied !== expected) {
    return res.status(401).json({ error: 'Unauthorised' });
  }
  const parsed = internalTaskSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
  }
  const d = parsed.data;

  // Retry-safe: same dedupeKey while still open → return the existing task, create nothing.
  if (d.dedupeKey) {
    const existing = await prisma.opsTask.findFirst({
      where: { tags: { has: `key:${d.dedupeKey}` }, status: 'open' },
    });
    if (existing) return res.json({ task: existing, deduped: true });
  }

  let assigneeIds: string[] = [];
  if (d.assigneeEmail) {
    const user = await prisma.user.findUnique({ where: { email: d.assigneeEmail }, select: { id: true } });
    if (user) assigneeIds = [user.id];
    else console.warn(`[INTERNAL_TASK] no user for ${d.assigneeEmail} — leaving unassigned`);
  }

  const task = await prisma.opsTask.create({
    data: {
      title: d.title,
      instructions: d.instructions ?? null,
      cadence: d.cadence,
      priority: d.priority,
      tags: d.dedupeKey ? [...d.tags, `key:${d.dedupeKey}`] : d.tags,
      assigneeIds,
      assigneeId: assigneeIds[0] ?? null,
    },
    include: taskInclude,
  });
  console.log(`[INTERNAL_TASK] created "${task.title}" (${d.priority}) for ${d.assigneeEmail || 'unassigned'}`);
  void notifyTaskAssignees(task.id);
  return res.status(201).json({ task });
});

// ---------------------------------------------------------------------------
// Daily reports — snapshots written by the 21:00 cron (see services/opsDailyReport)
// ---------------------------------------------------------------------------

router.get('/admin/reports', authenticate, requireAdmin, async (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit) || 60, 200);
  const reports = await prisma.opsDailyReport.findMany({
    orderBy: { reportDate: 'desc' },
    take: limit,
  });
  return res.json({ reports });
});

router.get('/admin/reports/:date', authenticate, requireAdmin, async (req: Request, res: Response) => {
  const report = await prisma.opsDailyReport.findUnique({ where: { reportDate: req.params.date } });
  if (!report) return res.status(404).json({ error: 'No report for that date' });
  return res.json({ report });
});

// Manual run — same path the cron takes. Upserts, so re-running a date is safe.
router.post('/admin/reports/run', authenticate, requireAdmin, async (req: Request, res: Response) => {
  const date = typeof req.body?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.body.date)
    ? req.body.date
    : ukDateString();
  try {
    const payload = await runDailyReport(date);
    return res.json({ report: payload });
  } catch (e: any) {
    console.error('[OPS_REPORT] manual run failed', e);
    return res.status(500).json({ error: e?.message || 'Report failed' });
  }
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
