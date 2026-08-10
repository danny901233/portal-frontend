// Lightweight arrears/lockout status for the logged-in user's garages. The portal
// polls this on load to decide whether to show the full-screen payment blocker.
// Available to ALL of a garage's users (not just managers) — everyone gets blocked.
// Internal ReceptionMate staff are never blocked.

import { Router } from 'express';
import type { Request, Response } from 'express';
import { prisma } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { resolveAllowedGarages } from '../utils/auth.js';
import { isGarageLocked } from '../utils/arrears.js';

const router = Router();

router.get('/billing/arrears-status', authenticate, async (req: Request, res: Response) => {
  // Internal staff are never locked out — they need portal access to support customers.
  if (req.user?.role === 'RECEPTIONMATE_STAFF') {
    return res.json({ lockedGarageIds: [] });
  }

  const garageIds = resolveAllowedGarages(req.user);
  if (garageIds.length === 0) return res.json({ lockedGarageIds: [] });

  try {
    const garages = await prisma.garage.findMany({
      where: { id: { in: garageIds } },
      select: { id: true, accessRestricted: true, paymentFailedAt: true },
    });

    const now = new Date();
    const lockedGarageIds = garages.filter((g) => isGarageLocked(g, now)).map((g) => g.id);

    // Persist the flag for any garage that has just crossed the grace window but whose
    // accessRestricted flag hasn't been flipped by the backstop sweep yet, so the
    // server-side call-content withholding + arrears emails engage immediately.
    const toFlip = garages
      .filter((g) => !g.accessRestricted && isGarageLocked(g, now))
      .map((g) => g.id);
    if (toFlip.length > 0) {
      await prisma.garage.updateMany({ where: { id: { in: toFlip } }, data: { accessRestricted: true } });
    }

    return res.json({ lockedGarageIds });
  } catch (err) {
    console.error('[ARREARS] status check failed:', err);
    // Fail open — never lock someone out because of a transient error.
    return res.json({ lockedGarageIds: [] });
  }
});

export default router;
