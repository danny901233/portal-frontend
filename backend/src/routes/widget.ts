import type { Request, Response } from 'express';
import { Router } from 'express';
import { prisma } from '../db.js';
import { authenticate } from '../middleware/auth.js';

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
        widgetLogoUrl: true,
        widgetPrimaryColor: true,
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
      primaryColor: garage.widgetPrimaryColor || '#2563eb',
      logoUrl: garage.widgetLogoUrl || null,
    });
  } catch (error) {
    console.error('Failed to get widget config:', error);
    res.status(500).json({ error: 'Failed to load widget configuration' });
  }
});

// PUT /api/widget/:garageId/branding - Update widget branding
router.put('/widget/:garageId/branding', authenticate, async (req: Request, res: Response) => {
  try {
    const { garageId } = req.params;
    const { widgetLogoUrl, widgetPrimaryColor } = req.body;

    // Verify user has access to this garage
    const user = (req as any).user;
    if (!user.garageAccessIds.includes(garageId)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Update garage with new branding
    const garage = await prisma.garage.update({
      where: { id: garageId },
      data: {
        widgetLogoUrl: widgetLogoUrl || null,
        widgetPrimaryColor: widgetPrimaryColor || null,
      },
      select: {
        id: true,
        widgetLogoUrl: true,
        widgetPrimaryColor: true,
      },
    });

    res.json({
      success: true,
      garage,
    });
  } catch (error) {
    console.error('Failed to update widget branding:', error);
    res.status(500).json({ error: 'Failed to update widget branding' });
  }
});

export default router;
