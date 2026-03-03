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
        twilioNumber: true,
        agentConfiguration: {
          select: { phoneNumber: true },
        },
      },
    });

    if (!garage) {
      return res.status(404).json({ error: 'Garage not found' });
    }

    // Build a wa.me-compatible number from the agent's phoneNumber (strip spaces/dashes,
    // convert leading 0 → 44 for UK numbers).
    const rawPhone = garage.agentConfiguration?.phoneNumber || garage.twilioNumber || '';
    const whatsappNumber = rawPhone.replace(/[^0-9+]/g, '').replace(/^\+/, '').replace(/^0+/, '44') || null;

    res.json({
      name: garage.name,
      phone: garage.twilioNumber,
      whatsappNumber,
      primaryColor: '#2563eb',
    });
  } catch (error) {
    console.error('Failed to get widget config:', error);
    res.status(500).json({ error: 'Failed to load widget configuration' });
  }
});

export default router;
