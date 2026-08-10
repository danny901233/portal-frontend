import type { Request, Response } from 'express';
import { Router } from 'express';
import { prisma } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { resolveAllowedGarages } from '../utils/auth.js';

const router = Router();

function hasGarageAccess(req: Request, garageId: string): boolean {
  if (!req.user) return false;
  const isStaff = req.user.role === 'RECEPTIONMATE_STAFF';
  if (isStaff) return true;
  return resolveAllowedGarages(req.user).includes(garageId);
}

// GET /api/garages/:garageId/social-connections - List all connections for a garage
router.get(
  '/garages/:garageId/social-connections',
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const { garageId } = req.params;

      if (!hasGarageAccess(req, garageId)) {
        return res.status(403).json({ error: 'Access denied' });
      }

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

// DELETE /api/social-connections/:connectionId - Disconnect a platform
router.delete(
  '/social-connections/:connectionId',
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const { connectionId } = req.params;

      const connection = await prisma.socialMediaConnection.findUnique({
        where: { id: connectionId },
        select: { garageId: true },
      });

      if (!connection) {
        return res.status(404).json({ error: 'Connection not found' });
      }

      if (!hasGarageAccess(req, connection.garageId)) {
        return res.status(403).json({ error: 'Access denied' });
      }

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
