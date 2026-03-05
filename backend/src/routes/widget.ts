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
        widgetLogoWidth: true,
        widgetLogoHeight: true,
        widgetPrimaryColor: true,
        widgetButtonColor: true,
        widgetButtonShape: true,
        widgetButtonIcon: true,
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
      buttonColor: garage.widgetButtonColor || null,
      logoUrl: garage.widgetLogoUrl || null,
      logoWidth: garage.widgetLogoWidth || 120,
      logoHeight: garage.widgetLogoHeight || 60,
      buttonShape: garage.widgetButtonShape || 'circle',
      buttonIcon: garage.widgetButtonIcon || 'chat',
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
    const { widgetLogoUrl, widgetLogoWidth, widgetLogoHeight, widgetPrimaryColor, widgetButtonColor, widgetButtonShape, widgetButtonIcon } = req.body;

    // Verify user has access to this garage
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Check if user has access to this garage
    const isStaff = user.role === 'RECEPTIONMATE_STAFF';
    const userGarageIds = user.garageIds || [];
    const hasAccess = isStaff || userGarageIds.includes(garageId) || (user.branchRoles && user.branchRoles[garageId]);
    
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Update garage with new branding
    const garage = await prisma.garage.update({
      where: { id: garageId },
      data: {
        widgetLogoUrl: widgetLogoUrl || null,
        widgetLogoWidth: widgetLogoWidth !== undefined ? widgetLogoWidth : 120,
        widgetLogoHeight: widgetLogoHeight !== undefined ? widgetLogoHeight : 60,
        widgetPrimaryColor: widgetPrimaryColor || null,
        widgetButtonColor: widgetButtonColor || null,
        widgetButtonShape: widgetButtonShape || 'circle',
        widgetButtonIcon: widgetButtonIcon || 'chat',
      },
      select: {
        id: true,
        widgetLogoUrl: true,
        widgetLogoWidth: true,
        widgetLogoHeight: true,
        widgetPrimaryColor: true,
        widgetButtonColor: true,
        widgetButtonShape: true,
        widgetButtonIcon: true,
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
