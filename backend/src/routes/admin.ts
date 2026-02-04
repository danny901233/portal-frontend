import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { authenticate, authenticateApiKey, requireAdmin } from '../middleware/auth.js';
import { sanitizeBranchRoles } from '../utils/branchRoles.js';
import { sendWelcomeEmail } from '../utils/email.js';

const router = Router();

const createBusinessSchema = z.object({
  name: z.string().min(1).max(200),
});

const updateBusinessContactSchema = z.object({
  contactName: z.string().max(200).optional(),
  contactEmail: z.string().email().max(200).optional().or(z.literal('')),
  contactPhone: z.string().max(100).optional(),
  contactRole: z.string().max(100).optional(),
});

const createBranchSchema = z.object({
  name: z.string().min(1).max(200),
});

const activateGarageSchema = z.object({
  twilioNumber: z.string().min(1).max(100),
});

const updateTwilioNumberSchema = z.object({
  twilioNumber: z
    .string()
    .max(100)
    .transform((value) => value.trim())
    .refine((value) => value.length > 0, {
      message: 'Twilio number is required.',
    }),
});

const branchRoleEnum = z.enum(['MANAGER', 'USER']);
const branchRolesSchema = z.record(branchRoleEnum);

const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(['ADMIN', 'USER', 'RECEPTIONMATE_STAFF']),
  garageAccessIds: z.array(z.string().uuid()).min(1),
  branchRoles: branchRolesSchema.optional(),
});

const updateUserSchema = z.object({
  password: z.string().min(8).optional(),
  role: z.enum(['ADMIN', 'USER', 'RECEPTIONMATE_STAFF']).optional(),
  garageAccessIds: z.array(z.string().uuid()).optional(),
  branchRoles: branchRolesSchema.optional(),
});

const ensureAdminAccessToGarage = async (garageId: string) => {
  const admins = await prisma.user.findMany({
    where: { role: 'ADMIN' },
  });

  await Promise.all(
    admins.map((admin) => {
      const currentIds = Array.isArray(admin.garageAccessIds) ? admin.garageAccessIds : [];
      const currentBranchRoles = sanitizeBranchRoles(admin.branchRoles);
      const hasAccess = currentIds.includes(garageId);
      const needsRole = currentBranchRoles[garageId] !== 'MANAGER';

      if (hasAccess && !needsRole) {
        return Promise.resolve();
      }

      const nextData: Prisma.UserUpdateInput = {};
      if (!hasAccess) {
        nextData.garageAccessIds = [...currentIds, garageId];
      }
      if (needsRole) {
        nextData.branchRoles = { ...currentBranchRoles, [garageId]: 'MANAGER' };
      }

      return prisma.user.update({
        where: { id: admin.id },
        data: nextData,
      });
    }),
  );
};

const formatBranch = (garage: {
  id: string;
  name: string;
  businessId: string | null;
  twilioNumber: string | null;
  agentConfiguration: {
    branchName: string;
    phoneNumber?: string | null;
    emailAddress?: string | null;
    callSummaryEmail?: string | null;
    notificationEmails?: string[];
  } | null;
}) => ({
  id: garage.id,
  name: garage.name,
  businessId: garage.businessId,
  twilioNumber: garage.twilioNumber ?? '',
  agentConfiguration: garage.agentConfiguration
    ? {
        branchName: garage.agentConfiguration.branchName,
        phoneNumber: garage.agentConfiguration.phoneNumber ?? '',
        emailAddress: garage.agentConfiguration.emailAddress ?? '',
        callSummaryEmail: garage.agentConfiguration.callSummaryEmail ?? '',
        notificationEmails: garage.agentConfiguration.notificationEmails ?? [],
      }
    : null,
});

router.get('/admin/businesses', authenticate, requireAdmin, async (_req, res) => {
  const businesses = await prisma.business.findMany({
    include: {
      garages: {
        include: { agentConfiguration: true },
        orderBy: { name: 'asc' },
      },
    },
    orderBy: { name: 'asc' },
  });

  res.json({
    businesses: businesses.map((business) => ({
      id: business.id,
      name: business.name,
      contactName: business.contactName,
      contactEmail: business.contactEmail,
      contactPhone: business.contactPhone,
      contactRole: business.contactRole,
      branches: business.garages.map(formatBranch),
    })),
  });
});

router.post('/admin/businesses', authenticateApiKey, requireAdmin, async (req, res) => {
  const parsed = createBusinessSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const business = await prisma.business.create({
    data: { name: parsed.data.name },
  });

  res.status(201).json({
    business: {
      id: business.id,
      name: business.name,
      branches: [],
    },
  });
});

router.patch('/admin/businesses/:businessId/contact', authenticateApiKey, requireAdmin, async (req, res) => {
  const { businessId } = req.params;
  const parsed = updateBusinessContactSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const business = await prisma.business.findUnique({ where: { id: businessId } });
  if (!business) {
    return res.status(404).json({ error: 'Business not found.' });
  }

  const updated = await prisma.business.update({
    where: { id: businessId },
    data: {
      contactName: parsed.data.contactName,
      contactEmail: parsed.data.contactEmail === '' ? null : parsed.data.contactEmail,
      contactPhone: parsed.data.contactPhone,
      contactRole: parsed.data.contactRole,
    },
  });

  res.json({
    business: {
      id: updated.id,
      name: updated.name,
      contactName: updated.contactName,
      contactEmail: updated.contactEmail,
      contactPhone: updated.contactPhone,
      contactRole: updated.contactRole,
    },
  });
});

router.post('/admin/businesses/:businessId/branches', authenticateApiKey, requireAdmin, async (req, res) => {
  const { businessId } = req.params;
  const parsed = createBranchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const business = await prisma.business.findUnique({ where: { id: businessId } });
  if (!business) {
    return res.status(404).json({ error: 'Business not found.' });
  }

  const garage = await prisma.garage.create({
    data: {
      name: parsed.data.name,
      businessId,
    },
  });

  const agentConfig = await prisma.agentConfiguration.create({
    data: {
      garageId: garage.id,
      branchName: parsed.data.name,
      tonePreference: 'standard',
      responseSpeed: 'normal',
      interruptionSensitivity: 0.5,
      allowFastFitOnly: false,
      integrationProvider: 'none',
    },
  });

  await ensureAdminAccessToGarage(garage.id);

  res.status(201).json({
    branch: formatBranch({
      id: garage.id,
      name: garage.name,
      businessId: garage.businessId,
      twilioNumber: garage.twilioNumber,
      agentConfiguration: agentConfig,
    }),
  });
});

router.post('/admin/garages/:garageId/activate', authenticateApiKey, requireAdmin, async (req, res) => {
  const { garageId } = req.params;
  const parsed = activateGarageSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const normalizedTwilioNumber = parsed.data.twilioNumber.trim();

  const garage = await prisma.garage.findUnique({
    where: { id: garageId },
    include: { agentConfiguration: true },
  });

  if (!garage) {
    return res.status(404).json({ error: 'Garage not found.' });
  }

  await prisma.garage.update({
    where: { id: garageId },
    data: { twilioNumber: normalizedTwilioNumber },
  });

  const onboardingEndpoint = process.env.ONBOARDING_SERVICE_URL;
  const onboardingSecret = process.env.ONBOARDING_SECRET;
  
  if (!onboardingEndpoint) {
    console.warn('ONBOARDING_SERVICE_URL is not configured');
    return res.status(202).json({
      status: 'queued',
      message: 'Onboarding service URL is not configured; request logged only.',
    });
  }

  const payload = {
    garageId,
    garageName: garage.name,
    branchName: null,
    contactEmail: null,
    contactPhone: null,
    twilioNumber: normalizedTwilioNumber,
    triggeredAt: new Date().toISOString(),
  };

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (onboardingSecret) {
      headers['x-onboarding-secret'] = onboardingSecret;
    }

    const response = await fetch(onboardingEndpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return res.status(502).json({
        error: 'Onboarding service rejected the request.',
        message: body || response.statusText,
      });
    }
  } catch (error) {
    console.error('Failed to call onboarding service', error);
    return res.status(502).json({ error: 'Failed to reach onboarding service.' });
  }

  res.status(202).json({ status: 'queued' });
});

router.put('/admin/garages/:garageId/twilio-number', authenticate, requireAdmin, async (req, res) => {
  const { garageId } = req.params;
  const parsed = updateTwilioNumberSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const garage = await prisma.garage.findUnique({ where: { id: garageId } });
  if (!garage) {
    return res.status(404).json({ error: 'Garage not found.' });
  }

  const updated = await prisma.garage.update({
    where: { id: garageId },
    data: { twilioNumber: parsed.data.twilioNumber },
  });

  res.json({
    twilioNumber: updated.twilioNumber ?? '',
  });
});

router.get('/admin/twilio-number', authenticate, requireAdmin, async (req, res) => {
  // For now, return the first garage's Twilio number as a fallback
  // This can be enhanced to handle specific garage selection later
  const garage = await prisma.garage.findFirst();
  
  res.json({
    twilioNumber: garage?.twilioNumber ?? '',
  });
});

router.delete('/admin/businesses/:businessId', authenticate, requireAdmin, async (req, res) => {
  const { businessId } = req.params;

  const business = await prisma.business.findUnique({
    where: { id: businessId },
    include: { garages: true },
  });

  if (!business) {
    return res.status(404).json({ error: 'Business not found.' });
  }

  // Get all branch IDs for this business
  const branchIds = business.garages.map((g) => g.id);

  // Remove branch access from all users
  if (branchIds.length > 0) {
    const users = await prisma.user.findMany({
      where: {
        garageAccessIds: {
          hasSome: branchIds,
        },
      },
    });

    await Promise.all(
      users.map((user) => {
        const nextIds = user.garageAccessIds.filter((id) => !branchIds.includes(id));
        return prisma.user.update({
          where: { id: user.id },
          data: { garageAccessIds: nextIds },
        });
      }),
    );
  }

  // Delete the business (cascade will delete branches)
  await prisma.business.delete({ where: { id: businessId } });

  res.status(204).end();
});

router.delete('/admin/branches/:branchId', authenticate, requireAdmin, async (req, res) => {
  const { branchId } = req.params;

  const branch = await prisma.garage.findUnique({ where: { id: branchId } });
  if (!branch) {
    return res.status(404).json({ error: 'Branch not found.' });
  }

  const users = await prisma.user.findMany({
    where: {
      garageAccessIds: {
        has: branchId,
      },
    },
  });

  await Promise.all(
    users.map((user) => {
      const nextIds = user.garageAccessIds.filter((id) => id !== branchId);
      return prisma.user.update({
        where: { id: user.id },
        data: { garageAccessIds: nextIds },
      });
    }),
  );

  await prisma.garage.delete({ where: { id: branchId } });

  res.status(204).end();
});

router.get('/admin/users', authenticate, requireAdmin, async (_req, res) => {
  const users = await prisma.user.findMany({
    orderBy: { email: 'asc' },
  });

  res.json({
    users: users.map((user) => ({
      id: user.id,
      email: user.email,
      garageAccessIds: user.garageAccessIds,
      role: user.role,
      branchRoles: sanitizeBranchRoles(user.branchRoles),
    })),
  });
});

router.post('/admin/users', authenticateApiKey, requireAdmin, async (req, res) => {
  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const passwordHash = await bcrypt.hash(parsed.data.password, 10);

  const user = await prisma.user.create({
    data: {
      email: parsed.data.email,
      passwordHash,
      mustChangePassword: true,
      garageAccessIds: Array.from(new Set(parsed.data.garageAccessIds)),
      role: parsed.data.role,
      branchRoles: parsed.data.branchRoles ?? {},
    },
  });

  res.status(201).json({
    user: {
      id: user.id,
      email: user.email,
      garageAccessIds: user.garageAccessIds,
      role: user.role,
      branchRoles: sanitizeBranchRoles(user.branchRoles),
    },
  });
});

router.delete('/admin/users/:userId', authenticate, requireAdmin, async (req, res) => {
  const { userId } = req.params;

  await prisma.user.delete({ where: { id: userId } });

  res.status(204).end();
});

router.put('/admin/users/:userId', authenticate, requireAdmin, async (req, res) => {
  const { userId } = req.params;
  const parsed = updateUserSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const prismaData: Prisma.UserUpdateInput = {};

  if (parsed.data.role) {
    prismaData.role = parsed.data.role;
  }
  if (parsed.data.garageAccessIds) {
    prismaData.garageAccessIds = Array.from(new Set(parsed.data.garageAccessIds));
  }
  if (parsed.data.password) {
    prismaData.passwordHash = await bcrypt.hash(parsed.data.password, 10);
  }
  if (parsed.data.branchRoles) {
    prismaData.branchRoles = parsed.data.branchRoles;
  }

  if (Object.keys(prismaData).length === 0) {
    return res.status(400).json({ error: 'Provide at least one field to update.' });
  }

  const user = await prisma.user.update({
    where: { id: userId },
    data: prismaData,
  });

  res.json({
    user: {
      id: user.id,
      email: user.email,
      garageAccessIds: user.garageAccessIds,
      role: user.role,
      branchRoles: sanitizeBranchRoles(user.branchRoles),
    },
  });
});

// Comprehensive onboarding endpoint
const completeOnboardingSchema = z.object({
  businessName: z.string().min(1).max(200),
  branchName: z.string().min(1).max(200),
  twilioNumber: z.string().min(1).max(100).optional(),
  userEmail: z.string().email(),
  userPassword: z.string().min(8).optional(),
  userRole: z.enum(['USER', 'ADMIN']).optional().default('USER'),
});

const DEFAULT_PASSWORD = 'Nomoremissedcalls';

router.post('/admin/onboard', authenticateApiKey, requireAdmin, async (req, res) => {
  const parsed = completeOnboardingSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    // 1. Create business
    const business = await prisma.business.create({
      data: { name: parsed.data.businessName },
    });

    // 2. Create branch/garage
    const garage = await prisma.garage.create({
      data: {
        name: parsed.data.branchName,
        businessId: business.id,
      },
    });

    // 3. Create agent configuration
    const agentConfig = await prisma.agentConfiguration.create({
      data: {
        garageId: garage.id,
        branchName: parsed.data.branchName,
        tonePreference: 'standard',
        responseSpeed: 'normal',
        interruptionSensitivity: 0.5,
        allowFastFitOnly: false,
        integrationProvider: 'none',
      },
    });

    // 4. Grant admin access
    await ensureAdminAccessToGarage(garage.id);

    // 5. Activate with Twilio (provision SIP trunk) - ONLY if Twilio number provided
    if (parsed.data.twilioNumber) {
      const onboardingUrl = process.env.ONBOARDING_SERVICE_URL || 'http://localhost:3002';
      const agentName = 'receptionmate-agent';
      const onboardingSecret = process.env.ONBOARDING_SECRET;

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (onboardingSecret) {
        headers['x-onboarding-secret'] = onboardingSecret;
      }

      const onboardResponse = await fetch(`${onboardingUrl}/provision`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          garageId: garage.id,
          garageName: garage.name,
          branchName: parsed.data.branchName,
          contactEmail: parsed.data.userEmail,
          twilioNumber: parsed.data.twilioNumber,
          agentName,
          triggeredAt: new Date().toISOString(),
        }),
      });

      if (!onboardResponse.ok) {
        throw new Error(`Onboarding service failed: ${await onboardResponse.text()}`);
      }

      await prisma.garage.update({
        where: { id: garage.id },
        data: { twilioNumber: parsed.data.twilioNumber },
      });
    }

    // 6. Create user account
    const actualPassword = parsed.data.userPassword || DEFAULT_PASSWORD;
    const passwordHash = await bcrypt.hash(actualPassword, 10);
    const user = await prisma.user.create({
      data: {
        email: parsed.data.userEmail,
        passwordHash,
        mustChangePassword: true,
        mustSetupPayment: true,
        garageAccessIds: [garage.id],
        role: parsed.data.userRole,
        branchRoles: { [garage.id]: 'MANAGER' },
      },
    });

    // 7. Send welcome email with login credentials
    const portalUrl = process.env.PORTAL_BASE_URL || 'https://portal.receptionmate.ai';
    await sendWelcomeEmail({
      to: parsed.data.userEmail,
      businessName: parsed.data.businessName,
      branchName: parsed.data.branchName,
      email: parsed.data.userEmail,
      password: actualPassword,
      portalUrl,
    }).catch((error) => {
      console.error('Failed to send welcome email:', error);
      // Don't fail the onboarding if email fails
    });

    res.status(201).json({
      success: true,
      business: {
        id: business.id,
        name: business.name,
      },
      branch: {
        id: garage.id,
        name: garage.name,
        twilioNumber: parsed.data.twilioNumber || null,
      },
      user: {
        id: user.id,
        email: user.email,
      },
    });
  } catch (error) {
    console.error('Onboarding failed:', error);
    res.status(500).json({
      error: 'Onboarding failed',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;