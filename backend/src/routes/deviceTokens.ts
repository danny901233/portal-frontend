// Device-token registration for mobile push notifications.
//
//   POST   /api/me/device-token   { token }  — register the current device
//   DELETE /api/me/device-token   { token }  — unregister (e.g. on logout)
//   PATCH  /api/me/push           { enabled } — toggle push for this user
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

router.patch('/me/push', authenticate, async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorised' });
  const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request' });

  await prisma.user.update({
    where: { id: req.user.userId },
    data: { pushEnabled: parsed.data.enabled },
  });
  return res.json({ success: true, pushEnabled: parsed.data.enabled });
});

export default router;
