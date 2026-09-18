// Device-token registration for mobile push notifications.
//
//   POST   /api/me/device-token   { token }  — register the current device
//   DELETE /api/me/device-token   { token }  — unregister (e.g. on logout)
//   GET    /api/me/push           — this user's push settings + the garages they can pick from
//   PATCH  /api/me/push           { enabled?, garageIds? } — toggle push / choose which garages
//
// Tokens are stored per-user (User.deviceTokens). The mobile app calls the
// POST endpoint after it obtains an APNs token; the DELETE on sign-out.

import type { Request, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

const tokenSchema = z.object({
  token: z.string().trim().min(10).max(400),
});

router.post('/me/device-token', authenticate, async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorised' });
  const parsed = tokenSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid token' });

  const user = await prisma.user.findUnique({
    where: { id: req.user.userId },
    select: { deviceTokens: true },
  });
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (user.deviceTokens.includes(parsed.data.token)) {
    return res.json({ success: true, alreadyRegistered: true });
  }

  // Keep the list bounded (most-recent 10 devices).
  const next = [...user.deviceTokens, parsed.data.token].slice(-10);
  await prisma.user.update({
    where: { id: req.user.userId },
    data: { deviceTokens: next },
  });
  return res.json({ success: true });
});

router.delete('/me/device-token', authenticate, async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorised' });
  const parsed = tokenSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid token' });

  const user = await prisma.user.findUnique({
    where: { id: req.user.userId },
    select: { deviceTokens: true },
  });
  if (!user) return res.status(404).json({ error: 'User not found' });

  await prisma.user.update({
    where: { id: req.user.userId },
    data: { deviceTokens: user.deviceTokens.filter((t) => t !== parsed.data.token) },
  });
  return res.json({ success: true });
});

/**
 * The garages this user could receive pushes from. Staff see every garage, because that is what
 * login grants them — anyone else sees the ones on their access list.
 */
async function pushableGarages(userId: string) {
  // Role comes from the database, not the JWT: a long-lived token can predate a role change, and
  // this decides what someone is allowed to store.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, garageAccessIds: true },
  });
  const where =
    user?.role === 'RECEPTIONMATE_STAFF'
      ? { archivedAt: null }
      : { id: { in: user?.garageAccessIds ?? [] }, archivedAt: null };
  return prisma.garage.findMany({ where, select: { id: true, name: true }, orderBy: { name: 'asc' } });
}

router.get('/me/push', authenticate, async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorised' });
  const user = await prisma.user.findUnique({
    where: { id: req.user.userId },
    select: { pushEnabled: true, pushGarageIds: true, deviceTokens: true },
  });
  if (!user) return res.status(404).json({ error: 'User not found' });

  return res.json({
    pushEnabled: user.pushEnabled,
    // Empty means "all of them" — the UI shows every garage ticked rather than none.
    pushGarageIds: user.pushGarageIds,
    deviceCount: user.deviceTokens.length,
    garages: await pushableGarages(req.user.userId),
  });
});

router.patch('/me/push', authenticate, async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorised' });
  const parsed = z
    .object({ enabled: z.boolean().optional(), garageIds: z.array(z.string()).optional() })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request' });
  if (parsed.data.enabled === undefined && parsed.data.garageIds === undefined) {
    return res.status(400).json({ error: 'Nothing to update' });
  }

  const data: { pushEnabled?: boolean; pushGarageIds?: string[] } = {};
  if (parsed.data.enabled !== undefined) data.pushEnabled = parsed.data.enabled;

  if (parsed.data.garageIds !== undefined) {
    // Only accept garages this person can actually receive from, so a stale or crafted id can't
    // sit in the list forever. Ticking every one is stored as [] — "all", including garages
    // onboarded later — which is what someone who wants the lot means.
    const allowed = new Set((await pushableGarages(req.user.userId)).map((g) => g.id));
    const picked = [...new Set(parsed.data.garageIds)].filter((id) => allowed.has(id));
    data.pushGarageIds = picked.length === allowed.size ? [] : picked;
  }

  const updated = await prisma.user.update({
    where: { id: req.user.userId },
    data,
    select: { pushEnabled: true, pushGarageIds: true },
  });
  return res.json({ success: true, ...updated });
});

export default router;
