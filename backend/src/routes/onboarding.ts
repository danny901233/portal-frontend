import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import twilio from 'twilio';
import { prisma } from '../db.js';
import { authenticateApiKey } from '../middleware/auth.js';
import type { Prisma } from '@prisma/client';

const router = Router();

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Helper function to auto-purchase a random UK number
async function purchaseRandomTwilioNumber(): Promise<string> {
  try {
    // Search for available UK numbers
    const availableNumbers = await twilioClient.availablePhoneNumbers('GB')
      .local
      .list({ limit: 5 });

    if (!availableNumbers.length) {
      throw new Error('No available UK numbers found');
    }

    // Pick the first available number
    const selectedNumber = availableNumbers[0].phoneNumber;
    console.log('[ONBOARDING] Auto-purchasing number:', selectedNumber);

    // Purchase the number with regulatory bundle
    const bundleSid = 'BU08d2714daf3a61874f914319204d51ca';
    const addressSid = 'AD5d175e286a33f9348f9b19aa4bdd513a';

    const purchasedNumber = await twilioClient.incomingPhoneNumbers.create({
      phoneNumber: selectedNumber,
      bundleSid,
      addressSid,
    });

    console.log('[ONBOARDING] Successfully purchased:', purchasedNumber.phoneNumber);
    return purchasedNumber.phoneNumber;
  } catch (error) {
    console.error('[ONBOARDING] Auto-purchase failed:', error);
    throw new Error('Failed to auto-purchase Twilio number: ' + (error as Error).message);
  }
}

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
  twilioNumber: z.string().optional(),
  autoPurchaseTwilioNumber: z.boolean().default(false),
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

  const { business: businessData, branch: branchData, user: userData, twilioNumber: providedTwilioNumber, autoPurchaseTwilioNumber, activateTwilio } = parsed.data;

  try {
    // Step 0: Auto-purchase Twilio number if requested
    let twilioNumber: string | null = providedTwilioNumber || null;
    if (autoPurchaseTwilioNumber && !twilioNumber) {
      try {
        twilioNumber = await purchaseRandomTwilioNumber();
        console.log('[ONBOARDING] Auto-purchased number:', twilioNumber);
      } catch (error) {
        console.error('[ONBOARDING] Auto-purchase failed:', error);
        // Continue without Twilio number - don't fail the entire onboarding
      }
    }

    // Step 1: Create business
    const business = await prisma.business.create({
      data: { name: businessData.name },
    });

    // Step 2: Create branch (garage)
    const garage = await prisma.garage.create({
      data: {
        name: branchData.name,
        businessId: business.id,
        twilioNumber,
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
    let provisioningFailed = false;
    if (activateTwilio && twilioNumber) {
      try {
        const onboardingUrl = process.env.ONBOARDING_SERVICE_URL || 'http://localhost:3002';
        const response = await fetch(`${onboardingUrl}/provision`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            garageId: garage.id,
            twilioNumber
          }),
        });

        if (!response.ok) {
          provisioningFailed = true;
          console.error('[ONBOARDING] Twilio provisioning failed:', await response.text());
        }
      } catch (err) {
        provisioningFailed = true;
        console.error('[ONBOARDING] Twilio activation failed:', err);
      }
    }

    const warnings = [];
    if (autoPurchaseTwilioNumber && !twilioNumber) {
      warnings.push('Auto-purchase of Twilio number failed');
    }
    if (activateTwilio && provisioningFailed) {
      warnings.push('Twilio provisioning failed');
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
        autoPurchased: autoPurchaseTwilioNumber && !!twilioNumber,
      },
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
      },
      warnings,
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
