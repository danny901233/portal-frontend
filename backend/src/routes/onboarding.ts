import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { prisma } from '../db.js';
import { authenticateApiKey } from '../middleware/auth.js';
import type { Prisma } from '@prisma/client';
import { sanitizeBranchRoles, branchRolesSchema } from '../utils/branchRoles.js';

const router = Router();

// Schema for complete onboarding request
const onboardingSchema = z.object({
  business: z.object({
    name: z.string().min(1),
  }),
  branch: z.object({
    name: z.string().min(1),
  }),
  user: z.object({
    email: z.string().email(),
    password: z.string().min(8),
    role: z.enum(['USER', 'ADMIN']).default('USER'),
  }),
  activateTwilio: z.boolean().default(false),
});

/**
 * POST /api/onboarding/complete
 * 
 * Complete end-to-end onboarding:
 * 1. Create business
 * 2. Create branch (garage)
 * 3. Create agent configuration
 * 4. Create user with access
 * 5. Optionally activate Twilio
 * 
 * Requires X-API-Key header
 */
router.post('/onboarding/complete', authenticateApiKey, async (req, res) => {
  const parsed = onboardingSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { business: businessData, branch: branchData, user: userData, activateTwilio } = parsed.data;

  try {
    // Step 1: Create business
    const business = await prisma.business.create({
      data: { name: businessData.name },
    });

    // Step 2: Create branch (garage)
    const garage = await prisma.garage.create({
      data: {
        name: branchData.name,
        businessId: business.id,
      },
    });

    // Step 3: Create agent configuration
    const agentConfig = await prisma.agentConfiguration.create({
      data: {
        garageId: garage.id,
        branchName: branchData.name,
        tonePreference: 'standard',
        responseSpeed: 'normal',
        interruptionSensitivity: 0.5,
        allowFastFitOnly: false,
        integrationProvider: 'none',
      },
    });

    // Step 4: Create user
    const passwordHash = await bcrypt.hash(userData.password, 10);
    const user = await prisma.user.create({
      data: {
        email: userData.email,
        passwordHash,
        mustChangePassword: true,
        garageAccessIds: [garage.id],
        role: userData.role,
        branchRoles: { [garage.id]: 'MANAGER' },
      },
    });

    // Step 5: Optionally activate Twilio
    let twilioNumber: string | null = null;
    if (activateTwilio) {
      try {
        const onboardingUrl = process.env.ONBOARDING_SERVICE_URL || 'http://localhost:3002';
        const response = await fetch(`${onboardingUrl}/provision`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ garageId: garage.id }),
        });

        if (response.ok) {
          const data = await response.json();
          twilioNumber = data.phoneNumber;

          await prisma.garage.update({
            where: { id: garage.id },
            data: { twilioNumber },
          });
        }
      } catch (err) {
        console.error('[ONBOARDING] Twilio activation failed:', err);
        // Continue even if Twilio fails - return warning
      }
    }

    res.status(201).json({
      success: true,
      business: {
        id: business.id,
        name: business.name,
      },
      branch: {
        id: garage.id,
        name: garage.name,
        twilioNumber,
      },
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
      },
      warnings: activateTwilio && !twilioNumber ? ['Twilio activation failed'] : [],
    });
  } catch (error) {
    console.error('[ONBOARDING] Error:', error);
    res.status(500).json({ error: 'Onboarding failed', details: (error as Error).message });
  }
});

/**
 * POST /api/onboarding/user
 * 
 * Add a new user to an existing branch
 * 
 * Requires X-API-Key header
 */
router.post('/onboarding/user', authenticateApiKey, async (req, res) => {
  const schema = z.object({
    branchId: z.string().uuid(),
    email: z.string().email(),
    password: z.string().min(8),
    role: z.enum(['USER', 'ADMIN']).default('USER'),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const garage = await prisma.garage.findUnique({ where: { id: parsed.data.branchId } });
    if (!garage) {
      return res.status(404).json({ error: 'Branch not found' });
    }

    const passwordHash = await bcrypt.hash(parsed.data.password, 10);
    const user = await prisma.user.create({
      data: {
        email: parsed.data.email,
        passwordHash,
        mustChangePassword: true,
        garageAccessIds: [parsed.data.branchId],
        role: parsed.data.role,
        branchRoles: { [parsed.data.branchId]: 'MANAGER' },
      },
    });

    res.status(201).json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        branchId: parsed.data.branchId,
      },
    });
  } catch (error) {
    console.error('[ONBOARDING] User creation error:', error);
    res.status(500).json({ error: 'User creation failed', details: (error as Error).message });
  }
});

export default router;
