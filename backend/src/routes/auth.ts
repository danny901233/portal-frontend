import type { Request, Response } from 'express';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../db.js';
import { loginSchema } from '../utils/validators.js';
import { sanitizeBranchRoles } from '../utils/branchRoles.js';

const router = Router();

router.post('/login', async (req: Request, res: Response) => {
  try {
    const result = loginSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: result.error.flatten() });
    }

    const { email, password, garageId: requestedGarageId } = result.data;

    const user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const matched = await bcrypt.compare(password, user.passwordHash);

    if (!matched) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    let allowedGarageIds = Array.isArray(user.garageAccessIds) ? [...user.garageAccessIds] : [];
    if (user.role === 'RECEPTIONMATE_STAFF') {
      const allGarages = await prisma.garage.findMany({ select: { id: true } });
      allowedGarageIds = allGarages.map((entry) => entry.id);
    }
    if (allowedGarageIds.length === 0) {
      const fallback = await prisma.garage.findFirst({ select: { id: true } });
      if (!fallback) {
        return res.status(404).json({ error: 'No garages available' });
      }
      allowedGarageIds = [fallback.id];
    }

    const selectedGarageId = requestedGarageId && allowedGarageIds.includes(requestedGarageId)
      ? requestedGarageId
      : allowedGarageIds[0];

    const garage = await prisma.garage.findUnique({ where: { id: selectedGarageId } });

    if (!garage) {
      return res.status(404).json({ error: 'Garage not found' });
    }

    const accessibleGarages = await prisma.garage.findMany({
      where: { id: { in: allowedGarageIds } },
      orderBy: { name: 'asc' },
    });


    const branchRoles = sanitizeBranchRoles(user.branchRoles);

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      throw new Error('JWT_SECRET is not configured');
    }

    const token = jwt.sign(
      {
        userId: user.id,
        email: user.email,
        garageIds: allowedGarageIds,
        role: user.role,
        branchRoles,
      },
      secret,
      { expiresIn: '12h' },
    );

    res.json({
      success: true,
      token,
      user: { id: user.id, email: user.email, role: user.role, branchRoles },
      selectedGarageId,
      garages: accessibleGarages.map((entry) => ({ id: entry.id, name: entry.name })),
    });
  } catch (error) {
    if (process.env.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.error('Login failed', error);
    }
    res.status(500).json({ error: 'Login failed' });
  }
});

export default router;
