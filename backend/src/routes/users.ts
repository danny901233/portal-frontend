import type { Request, Response } from 'express';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { prisma } from '../db.js';
import { authenticate, requireManager } from '../middleware/auth.js';
import { resolveAllowedGarages } from '../utils/auth.js';
import { sendWelcomeEmail } from '../utils/email.js';

const router = Router();

const VALID_ROLES = ['MANAGER', 'USER'] as const;
type AssignableRole = (typeof VALID_ROLES)[number];

function generateTempPassword(length = 12): string {
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%';
  let password = '';
  password += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[Math.floor(Math.random() * 26)];
  password += 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)];
  password += '0123456789'[Math.floor(Math.random() * 10)];
  password += '!@#$%'[Math.floor(Math.random() * 5)];
  for (let i = password.length; i < length; i++) {
    password += charset[Math.floor(Math.random() * charset.length)];
  }
  return password.split('').sort(() => Math.random() - 0.5).join('');
}

// GET /api/garage/:garageId/users — list all users for this garage
router.get(
  '/garage/:garageId/users',
  authenticate,
  requireManager,
  async (req: Request, res: Response) => {
    try {
      const { garageId } = req.params;
      const users = await prisma.user.findMany({
        where: { garageAccessIds: { has: garageId } },
        select: {
          id: true,
          email: true,
          role: true,
          branchRoles: true,
          mustChangePassword: true,
        },
        orderBy: { email: 'asc' },
      });

      const mapped = users.map((u) => {
        const branchRoles = u.branchRoles as Record<string, string> | null;
        const garageRole = branchRoles?.[garageId] ?? u.role;
        return {
          id: u.id,
          email: u.email,
          role: garageRole === 'RECEPTIONMATE_STAFF' ? 'MANAGER' : garageRole,
          status: u.mustChangePassword ? 'Invited' : 'Active',
        };
      });

      res.json({ users: mapped });
    } catch (error) {
      console.error('Failed to list users', error);
      res.status(500).json({ error: 'Failed to list users' });
    }
  },
);

// POST /api/garage/:garageId/users — invite a new user
router.post(
  '/garage/:garageId/users',
  authenticate,
  requireManager,
  async (req: Request, res: Response) => {
    try {
      const { garageId } = req.params;
      const { email, role } = req.body as { email?: string; role?: string };

      if (!email || !email.includes('@')) {
        return res.status(400).json({ error: 'Valid email is required' });
      }
      if (!role || !VALID_ROLES.includes(role as AssignableRole)) {
        return res.status(400).json({ error: 'Role must be MANAGER or USER' });
      }

      const garage = await prisma.garage.findUnique({ where: { id: garageId } });
      if (!garage) return res.status(404).json({ error: 'Garage not found' });

      // Check if user already exists
      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) {
        // If they already have access to this garage, reject
        if (existing.garageAccessIds.includes(garageId)) {
          return res.status(409).json({ error: 'User already has access to this garage' });
        }
        // Otherwise add this garage to their access
        const currentBranchRoles = (existing.branchRoles as Record<string, string>) ?? {};
        await prisma.user.update({
          where: { id: existing.id },
          data: {
            garageAccessIds: { push: garageId },
            branchRoles: { ...currentBranchRoles, [garageId]: role },
          },
        });
        return res.status(201).json({
          user: {
            id: existing.id,
            email: existing.email,
            role,
            status: existing.mustChangePassword ? 'Invited' : 'Active',
          },
        });
      }

      // Create new user with temp password
      const tempPassword = generateTempPassword();
      const passwordHash = await bcrypt.hash(tempPassword, 10);

      const user = await prisma.user.create({
        data: {
          email,
          passwordHash,
          mustChangePassword: true,
          role: role as AssignableRole,
          garageAccessIds: [garageId],
          branchRoles: { [garageId]: role },
        },
      });

      // Send invite email
      const portalUrl = process.env.PORTAL_URL ?? 'https://portal.receptionmate.co.uk';
      await sendWelcomeEmail({
        to: email,
        businessName: 'ReceptionMate',
        branchName: garage.name,
        email,
        password: tempPassword,
        portalUrl,
      }).catch((err) => console.error('Failed to send invite email', err));

      res.status(201).json({
        user: { id: user.id, email: user.email, role, status: 'Invited' },
      });
    } catch (error) {
      console.error('Failed to create user', error);
      res.status(500).json({ error: 'Failed to create user' });
    }
  },
);

// PUT /api/garage/:garageId/users/:userId — update role for this garage
router.put(
  '/garage/:garageId/users/:userId',
  authenticate,
  requireManager,
  async (req: Request, res: Response) => {
    try {
      const { garageId, userId } = req.params;
      const { role } = req.body as { role?: string };

      if (!role || !VALID_ROLES.includes(role as AssignableRole)) {
        return res.status(400).json({ error: 'Role must be MANAGER or USER' });
      }

      const user = await prisma.user.findFirst({
        where: { id: userId, garageAccessIds: { has: garageId } },
      });
      if (!user) return res.status(404).json({ error: 'User not found in this garage' });

      const currentBranchRoles = (user.branchRoles as Record<string, string>) ?? {};
      await prisma.user.update({
        where: { id: userId },
        data: { branchRoles: { ...currentBranchRoles, [garageId]: role } },
      });

      res.json({ ok: true });
    } catch (error) {
      console.error('Failed to update user role', error);
      res.status(500).json({ error: 'Failed to update user role' });
    }
  },
);

// DELETE /api/garage/:garageId/users/:userId — remove user from this garage
router.delete(
  '/garage/:garageId/users/:userId',
  authenticate,
  requireManager,
  async (req: Request, res: Response) => {
    try {
      const { garageId, userId } = req.params;

      // Cannot remove yourself
      if (req.user?.userId === userId) {
        return res.status(400).json({ error: 'You cannot remove yourself' });
      }

      const user = await prisma.user.findFirst({
        where: { id: userId, garageAccessIds: { has: garageId } },
      });
      if (!user) return res.status(404).json({ error: 'User not found in this garage' });

      // Guard: cannot remove the last manager
      const branchRoles = (user.branchRoles as Record<string, string>) ?? {};
      const userIsManager = branchRoles[garageId] === 'MANAGER' || user.role === 'MANAGER';
      if (userIsManager) {
        const allManagers = await prisma.user.findMany({
          where: { garageAccessIds: { has: garageId } },
          select: { id: true, role: true, branchRoles: true },
        });
        const managerCount = allManagers.filter((u) => {
          const br = (u.branchRoles as Record<string, string>) ?? {};
          return br[garageId] === 'MANAGER' || u.role === 'MANAGER';
        }).length;
        if (managerCount <= 1) {
          return res.status(400).json({ error: 'Cannot remove the last manager' });
        }
      }

      // Remove garage from their access
      const newGarageIds = user.garageAccessIds.filter((id) => id !== garageId);
      const { [garageId]: _removed, ...remainingBranchRoles } = branchRoles;

      await prisma.user.update({
        where: { id: userId },
        data: { garageAccessIds: newGarageIds, branchRoles: remainingBranchRoles },
      });

      res.json({ ok: true });
    } catch (error) {
      console.error('Failed to remove user', error);
      res.status(500).json({ error: 'Failed to remove user' });
    }
  },
);

// POST /api/garage/:garageId/users/:userId/resend-invite — resend invite email
router.post(
  '/garage/:garageId/users/:userId/resend-invite',
  authenticate,
  requireManager,
  async (req: Request, res: Response) => {
    try {
      const { garageId, userId } = req.params;

      const user = await prisma.user.findFirst({
        where: { id: userId, garageAccessIds: { has: garageId } },
      });
      if (!user) return res.status(404).json({ error: 'User not found in this garage' });

      const garage = await prisma.garage.findUnique({ where: { id: garageId } });
      if (!garage) return res.status(404).json({ error: 'Garage not found' });

      // Generate a fresh temp password
      const tempPassword = generateTempPassword();
      const passwordHash = await bcrypt.hash(tempPassword, 10);

      await prisma.user.update({
        where: { id: userId },
        data: { passwordHash, mustChangePassword: true },
      });

      const portalUrl = process.env.PORTAL_URL ?? 'https://portal.receptionmate.co.uk';
      await sendWelcomeEmail({
        to: user.email,
        businessName: 'ReceptionMate',
        branchName: garage.name,
        email: user.email,
        password: tempPassword,
        portalUrl,
      });

      res.json({ ok: true });
    } catch (error) {
      console.error('Failed to resend invite', error);
      res.status(500).json({ error: 'Failed to resend invite' });
    }
  },
);

export default router;
