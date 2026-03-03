import type { Request, Response } from 'express';
import { Router } from 'express';
import { prisma } from '../db.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

// GET /api/garages/:garageId/social-connections - List all connections for a garage
router.get(
  '/garages/:garageId/social-connections',
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const { garageId } = req.params;

      const connections = await prisma.socialMediaConnection.findMany({
        where: { garageId },
        orderBy: { createdAt: 'desc' },
      });

      res.json({ success: true, connections });
    } catch (error) {
      console.error('Failed to fetch social connections:', error);
      res.status(500).json({ error: 'Failed to fetch social connections' });
    }
  }
);

// POST /api/garages/:garageId/social-connections/livechat - Connect LiveChat
router.post(
  '/garages/:garageId/social-connections/livechat',
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const { garageId } = req.params;
      const { licenseId, entityId, personalAccessToken } = req.body;

      if (!licenseId || !personalAccessToken) {
        return res.status(400).json({ error: 'licenseId and personalAccessToken are required' });
      }

      // Upsert the LiveChat connection
      const connection = await prisma.socialMediaConnection.upsert({
        where: { garageId_platform: { garageId, platform: 'livechat' } },
        update: {
          whatsappPhoneNumberId: String(licenseId),
          pageId: entityId ? String(entityId) : null,
          accessToken: personalAccessToken,
          isActive: true,
        },
        create: {
          garageId,
          platform: 'livechat',
          whatsappPhoneNumberId: String(licenseId),
          pageId: entityId ? String(entityId) : null,
          accessToken: personalAccessToken,
          isActive: true,
        },
      });

      res.json({ success: true, connection });
    } catch (error) {
      console.error('Failed to save LiveChat connection:', error);
      res.status(500).json({ error: 'Failed to save LiveChat connection' });
    }
  }
);

// DELETE /api/social-connections/:connectionId - Disconnect a platform
router.delete(
  '/social-connections/:connectionId',
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const { connectionId } = req.params;

      await prisma.socialMediaConnection.delete({
        where: { id: connectionId },
      });

      res.json({ success: true });
    } catch (error) {
      console.error('Failed to delete social connection:', error);
      res.status(500).json({ error: 'Failed to delete social connection' });
    }
  }
);

export default router;
