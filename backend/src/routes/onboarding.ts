import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import twilio from 'twilio';
import { prisma } from '../db.js';
import { authenticateApiKey, authenticate } from '../middleware/auth.js';
import { sendWelcomeEmail } from '../utils/email.js';
import { fetchWebsiteInfo } from '../utils/scraper.js';
import type { Prisma } from '@prisma/client';

const router = Router();

// Lazy-load Twilio client only when needed
function getTwilioClient() {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    throw new Error('Twilio credentials not configured');
  }
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

// Helper function to auto-purchase a random UK number
async function purchaseRandomTwilioNumber(): Promise<string> {
  try {
    const client = getTwilioClient();

    // Search for available UK numbers
    const availableNumbers = await client.availablePhoneNumbers('GB')
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

    const purchasedNumber = await client.incomingPhoneNumbers.create({
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

// Helper: Generate random password
function generateRandomPassword(): string {
  const length = 12;
  const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
  let password = '';
  password += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[Math.floor(Math.random() * 26)];
  password += 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)];
  password += '0123456789'[Math.floor(Math.random() * 10)];
  password += '!@#$%^&*'[Math.floor(Math.random() * 8)];
  for (let i = password.length; i < length; i++) {
    password += charset[Math.floor(Math.random() * charset.length)];
  }
  return password.split('').sort(() => Math.random() - 0.5).join('');
}

// Helper: Parse opening hours from text array
function parseOpeningHours(hoursTexts: string[]): any {
  const result: any = {};
  const text = hoursTexts.join(' ').toLowerCase();

  const dayMap: Record<string, string> = {
    'monday': 'monday', 'mon': 'monday',
    'tuesday': 'tuesday', 'tue': 'tuesday', 'tues': 'tuesday',
    'wednesday': 'wednesday', 'wed': 'wednesday',
    'thursday': 'thursday', 'thu': 'thursday', 'thur': 'thursday',
    'friday': 'friday', 'fri': 'friday',
    'saturday': 'saturday', 'sat': 'saturday',
    'sunday': 'sunday', 'sun': 'sunday',
  };

  // Try to extract day-specific hours or ranges
  // Pattern: "Monday: 9:00am - 5:00pm" or "Mon-Fri 9am-5pm"
  const rangePattern = /(monday|mon|tuesday|tue|wednesday|wed|thursday|thu|friday|fri|saturday|sat|sunday|sun)\s*[-–to]+\s*(monday|mon|tuesday|tue|wednesday|wed|thursday|thu|friday|fri|saturday|sat|sunday|sun)[:\s]*(\d{1,2}):?(\d{2})?\s*(am|pm)?\s*[-–to]+\s*(\d{1,2}):?(\d{2})?\s*(am|pm)?/gi;

  let match;
  while ((match = rangePattern.exec(text)) !== null) {
    const startDayKey = match[1].toLowerCase();
    const endDayKey = match[2].toLowerCase();
    const startDay = dayMap[startDayKey];
    const endDay = dayMap[endDayKey];

    if (startDay && endDay) {
      const openTime = convertTo24Hour(`${match[3]}${match[4] ? ':' + match[4] : ''}${match[5] || ''}`);
      const closeTime = convertTo24Hour(`${match[6]}${match[7] ? ':' + match[7] : ''}${match[8] || ''}`);

      if (openTime && closeTime) {
        const dayOrder = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
        const startIdx = dayOrder.indexOf(startDay);
        const endIdx = dayOrder.indexOf(endDay);

        for (let i = startIdx; i <= endIdx; i++) {
          result[dayOrder[i]] = { open: openTime, close: closeTime, closed: false };
        }
      }
    }
  }

  // If no ranges found, try generic times for weekdays
  if (Object.keys(result).length === 0) {
    const timePattern = /(\d{1,2}):?(\d{2})?\s*(am|pm)?\s*[-–to]+\s*(\d{1,2}):?(\d{2})?\s*(am|pm)?/i;
    const timeMatch = timePattern.exec(text);

    if (timeMatch) {
      const openTime = convertTo24Hour(`${timeMatch[1]}${timeMatch[2] ? ':' + timeMatch[2] : ''}${timeMatch[3] || ''}`);
      const closeTime = convertTo24Hour(`${timeMatch[4]}${timeMatch[5] ? ':' + timeMatch[5] : ''}${timeMatch[6] || ''}`);

      if (openTime && closeTime) {
        ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'].forEach(day => {
          result[day] = { open: openTime, close: closeTime, closed: false };
        });
      }
    }
  }

  return result;
}

// Helper: Convert time to 24-hour format
function convertTo24Hour(timeStr: string): string | null {
  const normalized = timeStr.trim().toLowerCase();
  const match = normalized.match(/(\d{1,2}):?(\d{2})?\s*(am|pm)?/);
  if (!match) return null;

  let hours = parseInt(match[1], 10);
  const minutes = match[2] || '00';
  const period = match[3];

  if (period === 'pm' && hours !== 12) {
    hours += 12;
  } else if (period === 'am' && hours === 12) {
    hours = 0;
  } else if (!period && hours < 8) {
    hours += 12;
  }

  if (hours < 0 || hours > 23) return null;
  return `${hours.toString().padStart(2, '0')}:${minutes}`;
}

// Schema for comprehensive onboarding
const comprehensiveOnboardingSchema = z.object({
  branchName: z.string().min(1).max(200),
  contactName: z.string().min(1).max(200),
  contactEmail: z.string().email().max(200),
  websiteUrl: z.string().url().max(500),
  agentType: z.enum(['assist', 'automate']),
  subscriptionCostGbp: z.number().min(0),
  includedMinutes: z.number().int().min(0).default(400),
  trialType: z.enum(['days', 'bookings']).optional(),
  trialDays: z.number().int().min(0).optional(),
  requireBookings: z.number().int().min(0).optional(),
  autoPurchaseTwilioNumber: z.boolean().default(true),
  activateTwilio: z.boolean().default(true),
});

/**
 * POST /api/onboarding/create-business
 *
 * Comprehensive onboarding endpoint that creates everything:
 * - Business with contact details
 * - Branch with billing config (£0.25/min always)
 * - Agent config with optimal defaults (upbeat tone, fast speed)
 * - User account with auto-generated password
 * - Trial (14 days OR 4 bookings)
 * - Auto-purchase Twilio number
 * - Send welcome email with credentials
 */
router.post('/onboarding/create-business', authenticateApiKey, async (req, res) => {
  const parsed = comprehensiveOnboardingSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
  }

  const {
    branchName,
    contactName,
    contactEmail,
    websiteUrl,
    agentType,
    subscriptionCostGbp,
    includedMinutes,
    trialType,
    trialDays,
    requireBookings,
    autoPurchaseTwilioNumber,
    activateTwilio,
  } = parsed.data;

  try {
    // Step 1: Auto-purchase Twilio number
    let twilioNumber: string | null = null;
    if (autoPurchaseTwilioNumber) {
      try {
        twilioNumber = await purchaseRandomTwilioNumber();
        console.log('[ONBOARDING] Purchased number:', twilioNumber);
      } catch (error) {
        console.error('[ONBOARDING] Failed to purchase number:', error);
        // Continue without number - can be added later
      }
    }

    // Step 2: Determine trial settings
    let trialEndDate: Date | null = null;
    let requiresBookingActivation = false;
    let bookingsRequiredForActivation = 0;

    if (trialType === 'days' && trialDays && trialDays > 0) {
      trialEndDate = new Date();
      trialEndDate.setDate(trialEndDate.getDate() + trialDays);
      console.log(`[ONBOARDING] ${trialDays}-day trial until ${trialEndDate.toISOString()}`);
    } else if (trialType === 'bookings' && requireBookings && requireBookings > 0) {
      requiresBookingActivation = true;
      bookingsRequiredForActivation = requireBookings;
      console.log(`[ONBOARDING] Requires ${requireBookings} bookings for activation`);
    }

    // Step 3: Create business
    console.log(`[ONBOARDING] Creating business: ${branchName}`);
    const business = await prisma.business.create({
      data: {
        name: branchName,
        contactName,
        contactEmail,
        contactPhone: '',
        contactRole: 'Owner',
      },
    });

    // Step 4: Create garage with billing config
    console.log('[ONBOARDING] Creating garage with billing config...');
    const garage = await prisma.garage.create({
      data: {
        name: branchName,
        businessId: business.id,
        twilioNumber,
        hasMessagingAccess: false,
        // Billing: Always £0.25/min
        subscriptionCostGbp,
        includedMinutes,
        costPerMinuteGbp: 0.25,
        vatRate: 0.20,
        // Trial/activation
        trialEndDate,
        requiresBookingActivation,
        bookingsRequiredForActivation,
        activationBookingsCount: 0,
        subscriptionActivatedAt: null,
      },
    });

    // Step 5: Scan website and extract business details
    console.log('[ONBOARDING] Scanning website:', websiteUrl);
    let scannedPhone = '';
    let scannedAddress = '';
    let scannedHours: any = {};

    try {
      const websiteInfo = await fetchWebsiteInfo(websiteUrl);
      console.log('[ONBOARDING] Website scan results:', {
        phones: websiteInfo.phoneNumbers,
        emails: websiteInfo.emails,
        address: websiteInfo.address,
        hours: websiteInfo.hours,
      });

      // Extract phone number (first one found)
      if (websiteInfo.phoneNumbers && websiteInfo.phoneNumbers.length > 0) {
        scannedPhone = websiteInfo.phoneNumbers[0];
        console.log('[ONBOARDING] Found phone:', scannedPhone);
      }

      // Extract address
      if (websiteInfo.address) {
        scannedAddress = websiteInfo.address;
        console.log('[ONBOARDING] Found address:', scannedAddress);
      }

      // Parse opening hours
      if (websiteInfo.hours && websiteInfo.hours.length > 0) {
        scannedHours = parseOpeningHours(websiteInfo.hours);
        console.log('[ONBOARDING] Parsed hours:', scannedHours);
      }
    } catch (error) {
      console.error('[ONBOARDING] Website scan failed:', error);
      // Continue without scanned data - not critical
    }

    // Step 6: Create agent config with optimal defaults + scanned data
    const greeting = `[timeofday] ${branchName}, Leah speaking, how can I help?`;
    console.log('[ONBOARDING] Creating agent config with greeting:', greeting);

    const agentConfig = await prisma.agentConfiguration.create({
      data: {
        garageId: garage.id,
        branchName,
        phoneNumber: scannedPhone || '',
        emailAddress: contactEmail,
        branchAddress: scannedAddress || '',
        websiteUrl,
        weeklyOpeningHours: scannedHours,
        holidayClosures: '',
        greetingLine: greeting,
        tonePreference: 'upbeat', // Fast/energetic
        responseSpeed: 'fast', // Quickest
        interruptionSensitivity: 0.3, // Low = faster responses
        allowFastFitOnly: false,
        notificationEmails: [contactEmail],
        integrationProvider: 'none',
        agentType,
        enableSmsBookingLinks: true,
      },
    });

    // Step 7: Create user account with standard password
    const standardPassword = 'Nomoremissedcalls';
    const passwordHash = await bcrypt.hash(standardPassword, 10);

    console.log('[ONBOARDING] Creating user account...');
    const user = await prisma.user.create({
      data: {
        email: contactEmail,
        passwordHash,
        mustChangePassword: true, // Force change on first login
        mustSetupPayment: true, // Always require payment setup, even for trial users
        garageAccessIds: [garage.id],
        role: 'USER',
        branchRoles: { [garage.id]: 'MANAGER' },
      },
    });

    // Step 8: Send welcome email
    console.log('[ONBOARDING] Sending welcome email...');
    try {
      const portalUrl = process.env.PORTAL_URL || 'https://portal.receptionmate.co.uk';
      await sendWelcomeEmail({
        to: contactEmail,
        businessName: branchName,
        branchName: branchName,
        email: contactEmail,
        password: standardPassword,
        portalUrl,
      });
      console.log('[ONBOARDING] Welcome email sent successfully');
    } catch (error) {
      console.error('[ONBOARDING] Failed to send welcome email:', error);
    }

    // Step 9: Optionally activate Twilio
    let provisioningFailed = false;
    if (activateTwilio && twilioNumber) {
      try {
        const onboardingUrl = process.env.ONBOARDING_SERVICE_URL || 'http://localhost:3002';
        const onboardingSecret = process.env.ONBOARDING_SECRET;

        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (onboardingSecret) {
          headers['x-onboarding-secret'] = onboardingSecret;
        }

        // Get agent configuration to determine which agent version to use
        const agentConfig = await prisma.agentConfiguration.findUnique({
          where: { garageId: garage.id },
          select: { agentScript: true },
        });
        const agentName = agentConfig?.agentScript === 'tyresoft-agent'
          ? 'tyresoft-agent'
          : agentConfig?.agentScript === 'receptionmate-agent-v3' 
            ? 'receptionmate-agent-v3' 
            : 'receptionmate-agent';

        const response = await fetch(`${onboardingUrl}/provision`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            garageId: garage.id,
            garageName: garage.name,
            branchName,
            contactEmail,
            twilioNumber,
            agentName,
            triggeredAt: new Date().toISOString(),
          }),
        });

        if (!response.ok) {
          provisioningFailed = true;
          console.error('[ONBOARDING] Provisioning failed:', await response.text());
        } else {
          console.log('[ONBOARDING] Twilio provisioned successfully');
        }
      } catch (err) {
        provisioningFailed = true;
        console.error('[ONBOARDING] Twilio activation failed:', err);
      }
    }

    const warnings = [];
    if (autoPurchaseTwilioNumber && !twilioNumber) {
      warnings.push('Failed to purchase Twilio number');
    }
    if (activateTwilio && provisioningFailed) {
      warnings.push('Twilio provisioning failed');
    }

    // Return complete onboarding data
    return res.status(201).json({
      success: true,
      message: 'Business onboarded successfully',
      data: {
        business: {
          id: business.id,
          name: business.name,
          contactName,
          contactEmail,
        },
        branch: {
          id: garage.id,
          name: garage.name,
          twilioNumber,
        },
        user: {
          id: user.id,
          email: user.email,
          temporaryPassword: standardPassword,
        },
        billing: {
          subscriptionCostGbp,
          includedMinutes,
          costPerMinuteGbp: 0.25,
          vatRate: 0.20,
          trialEndDate: trialEndDate?.toISOString() ?? null,
          requiresBookingActivation,
          bookingsRequiredForActivation,
        },
        agentConfig: {
          id: agentConfig.id,
          agentType,
          greeting,
          tonePreference: 'upbeat',
          responseSpeed: 'fast',
          websiteUrl,
          scannedData: {
            phoneNumber: scannedPhone || null,
            address: scannedAddress || null,
            openingHours: Object.keys(scannedHours).length > 0 ? scannedHours : null,
          },
        },
      },
      warnings,
    });
  } catch (error) {
    console.error('[ONBOARDING] Error:', error);
    return res.status(500).json({
      error: 'Failed to create business',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

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
    role: z.enum(['USER', 'MANAGER']).default('USER'),
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
    const defaultGreeting = `Good [morning/afternoon/evening], ${branchData.name}, Leah speaking how may I help?`;
    const agentConfig = await prisma.agentConfiguration.create({
      data: {
        garageId: garage.id,
        branchName: branchData.name,
        greetingLine: defaultGreeting,
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
        mustSetupPayment: true, // Always require payment setup
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
        const onboardingSecret = process.env.ONBOARDING_SECRET;

        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (onboardingSecret) {
          headers['x-onboarding-secret'] = onboardingSecret;
        }

        const response = await fetch(`${onboardingUrl}/provision`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            garageId: garage.id,
            garageName: garage.name,
            branchName: branchData.name,
            contactEmail: userData.email,
            twilioNumber,
            agentName: 'receptionmate-agent',
            triggeredAt: new Date().toISOString(),
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
    role: z.enum(['USER', 'MANAGER']).default('USER'),
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

/**
 * GET /api/onboarding/status
 *
 * Check if the logged-in user needs to complete the setup wizard
 * Returns: needsSetup boolean and agent type
 */
router.get('/onboarding/status', authenticate, async (req, res) => {
  try {
    if (!req.user?.userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: {
        garageAccessIds: true,
        email: true,
        role: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // ReceptionMate staff never need setup wizard
    const isReceptionMateStaff = user.role === 'RECEPTIONMATE_STAFF';

    // Get garage setup status and agent type from first garage
    let agentType = 'assist'; // default
    let needsSetup = false;

    // Skip setup wizard for ReceptionMate staff
    if (isReceptionMateStaff) {
      needsSetup = false;
    } else if (user.garageAccessIds && user.garageAccessIds.length > 0) {
      const garage = await prisma.garage.findUnique({
        where: { id: user.garageAccessIds[0] },
        select: {
          setupWizardCompleted: true,
          agentConfiguration: {
            select: {
              agentType: true,
            },
          },
        },
      });

      if (garage) {
        needsSetup = !garage.setupWizardCompleted;
        agentType = garage.agentConfiguration?.agentType || 'assist';
      }
    }

    res.json({
      needsSetup,
      agentType,
    });
  } catch (error) {
    console.error('[ONBOARDING] Status check error:', error);
    res.status(500).json({ error: 'Failed to check onboarding status' });
  }
});

/**
 * POST /api/onboarding/wizard-complete
 *
 * Mark the setup wizard as completed for the garage
 */
router.post('/onboarding/wizard-complete', authenticate, async (req, res) => {
  try {
    if (!req.user?.userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: {
        garageAccessIds: true,
        email: true,
        role: true,
      },
    });

    if (!user || !user.garageAccessIds || user.garageAccessIds.length === 0) {
      return res.status(404).json({ error: 'No garage access found' });
    }

    // Mark the first garage as setup complete
    await prisma.garage.update({
      where: { id: user.garageAccessIds[0] },
      data: {
        setupWizardCompleted: true,
        setupWizardCompletedAt: new Date(),
      },
    });

    res.json({
      success: true,
      message: 'Setup wizard completed',
    });
  } catch (error) {
    console.error('[ONBOARDING] Wizard completion error:', error);
    res.status(500).json({ error: 'Failed to complete wizard' });
  }
});

/**
 * GET /api/onboarding/initial-data
 *
 * Get initial data for wizard pre-population:
 * - Existing agent configuration
 * - Business billing info
 * - Twilio number
 * - Agent type
 */
router.get('/onboarding/initial-data', authenticate, async (req, res) => {
  try {
    if (!req.user?.userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: {
        garageAccessIds: true,
        email: true,
        role: true,
      },
    });

    if (!user || !user.garageAccessIds || user.garageAccessIds.length === 0) {
      return res.status(404).json({ error: 'No garage access found' });
    }

    const garageId = user.garageAccessIds[0];

    // Fetch garage with agent config and business info
    const garage = await prisma.garage.findUnique({
      where: { id: garageId },
      include: {
        agentConfiguration: true,
        business: true,
      },
    });

    if (!garage) {
      return res.status(404).json({ error: 'Garage not found' });
    }

    res.json({
      garageId: garage.id,
      twilioNumber: garage.twilioNumber,
      agentType: garage.agentConfiguration?.agentType || 'assist',
      agentConfiguration: garage.agentConfiguration ? {
        branchName: garage.agentConfiguration.branchName,
        phoneNumber: garage.agentConfiguration.phoneNumber,
        emailAddress: garage.agentConfiguration.emailAddress,
        branchAddress: garage.agentConfiguration.branchAddress,
        websiteUrl: garage.agentConfiguration.websiteUrl,
        weeklyOpeningHours: garage.agentConfiguration.weeklyOpeningHours,
        holidayClosures: garage.agentConfiguration.holidayClosures,
        greetingLine: garage.agentConfiguration.greetingLine,
        voice: garage.agentConfiguration.voice,
        allowFastFitOnly: garage.agentConfiguration.allowFastFitOnly,
        enableSmsBookingLinks: garage.agentConfiguration.enableSmsBookingLinks,
        notificationEmails: garage.agentConfiguration.notificationEmails,
      } : null,
      businessInfo: garage.business ? {
        name: garage.business.name,
        billingAddress: garage.business.billingAddress,
        billingCity: garage.business.billingCity,
        billingPostcode: garage.business.billingPostcode,
        billingCountry: garage.business.billingCountry,
        vatNumber: garage.business.vatNumber,
        companyRegNumber: garage.business.companyRegNumber,
        billingEmail: garage.business.billingEmail,
      } : null,
    });
  } catch (error) {
    console.error('[ONBOARDING] Initial data fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch initial data' });
  }
});

export default router;
