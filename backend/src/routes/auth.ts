import type { Request, Response } from 'express';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../db.js';
import { loginSchema } from '../utils/validators.js';

const router = Router();

router.post('/login', async (req: Request, res: Response) => {
  try {
    const result = loginSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: result.error.flatten() });
    }

    const { email, password, garageId } = result.data;

    const user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const matched = await bcrypt.compare(password, user.passwordHash);

    if (!matched) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const garage = await prisma.garage.findUnique({ where: { id: garageId } });

    if (!garage) {
      return res.status(404).json({ error: 'Garage not found' });
    }

    const allowedGarageIds = Array.isArray(user.garageAccessIds) && user.garageAccessIds.length > 0
      ? user.garageAccessIds
      : [garageId];

    if (!allowedGarageIds.includes(garageId)) {
      return res.status(403).json({ error: 'You do not have access to this garage' });
    }

    const accessibleGarages = await prisma.garage.findMany({
      where: { id: { in: allowedGarageIds } },
      orderBy: { name: 'asc' },
    });

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      throw new Error('JWT_SECRET is not configured');
    }

    const token = jwt.sign(
      {
        userId: user.id,
        email: user.email,
        garageIds: allowedGarageIds,
      },
      secret,
      { expiresIn: '12h' },
    );

    res.json({
      success: true,
      token,
      user: { id: user.id, email: user.email },
      selectedGarageId: garage.id,
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
