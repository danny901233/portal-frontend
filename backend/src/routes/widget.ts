import type { Request, Response } from 'express';
import { Router } from 'express';
import { prisma } from '../db.js';

const router = Router();

// GET /api/widget/:garageId - Get garage configuration for widget
router.get('/widget/:garageId', async (req: Request, res: Response) => {
  try {
    const { garageId } = req.params;

    const garage = await prisma.garage.findUnique({
      where: { id: garageId },
      select: {
        id: true,
        name: true,
        phoneNumber: true,
        whatsappNumber: true,
        widgetPrimaryColor: true,
      },
    });

    if (!garage) {
      return res.status(404).json({ error: 'Garage not found' });
    }

    res.json({
      name: garage.name,
      phone: garage.phoneNumber,
      whatsappNumber: garage.whatsappNumber,
      primaryColor: garage.widgetPrimaryColor || '#2563eb',
    });
  } catch (error) {
    console.error('Failed to get widget config:', error);
    res.status(500).json({ error: 'Failed to load widget configuration' });
  }
});

export default router;
