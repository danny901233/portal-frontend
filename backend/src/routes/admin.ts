import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { authenticate, authenticateApiKey, requireAdmin, forgetRevocation } from '../middleware/auth.js';
import { accountForAgentScript } from '../utils/agentAccount.js';
import { fetchPlaceDetails, placesAutocomplete } from '../utils/googlePlaces.js';
import { industryDefaultFaqs, generateFaqsFromWebsite } from '../utils/faqGenerator.js';
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
  role: z.enum(['MANAGER', 'USER', 'RECEPTIONMATE_STAFF']),
  garageAccessIds: z.array(z.string().uuid()).min(1),
  branchRoles: branchRolesSchema.optional(),
});

const updateUserSchema = z.object({
  password: z.string().min(8).optional(),
  role: z.enum(['MANAGER', 'USER', 'RECEPTIONMATE_STAFF']).optional(),
  garageAccessIds: z.array(z.string().uuid()).optional(),
  branchRoles: branchRolesSchema.optional(),
  mustSetupPayment: z.boolean().optional(),
});

export const ensureAdminAccessToGarage = async (garageId: string) => {
  // Only grant access to RECEPTIONMATE_STAFF — not all ADMIN users,
  // since each business has its own ADMIN users who should only see their own garages
  const admins = await prisma.user.findMany({
    where: { role: 'RECEPTIONMATE_STAFF' },
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
  hasMessagingAccess?: boolean;
  subscriptionCostGbp?: number;
  includedMinutes?: number;
  costPerMinuteGbp?: number;
  vatRate?: number;
  trialEndDate?: Date | null;
  requiresBookingActivation?: boolean;
  bookingsRequiredForActivation?: number;
  activationBookingsCount?: number;
  subscriptionActivatedAt?: Date | null;
  agentConfiguration: {
    branchName: string;
    phoneNumber?: string | null;
    emailAddress?: string | null;
    notificationEmails?: string[];
  } | null;
}) => ({
  id: garage.id,
  name: garage.name,
  businessId: garage.businessId,
  twilioNumber: garage.twilioNumber ?? '',
  hasMessagingAccess: garage.hasMessagingAccess ?? false,
  subscriptionCostGbp: garage.subscriptionCostGbp ?? 0,
  includedMinutes: garage.includedMinutes ?? 0,
  costPerMinuteGbp: garage.costPerMinuteGbp ?? 0,
  vatRate: garage.vatRate ?? 0.20,
  trialEndDate: garage.trialEndDate?.toISOString() ?? null,
  requiresBookingActivation: garage.requiresBookingActivation ?? false,
  bookingsRequiredForActivation: garage.bookingsRequiredForActivation ?? 4,
  activationBookingsCount: garage.activationBookingsCount ?? 0,
  subscriptionActivatedAt: garage.subscriptionActivatedAt?.toISOString() ?? null,
  agentConfiguration: garage.agentConfiguration
    ? {
        branchName: garage.agentConfiguration.branchName,
        phoneNumber: garage.agentConfiguration.phoneNumber ?? '',
        emailAddress: garage.agentConfiguration.emailAddress ?? '',
        notificationEmails: garage.agentConfiguration.notificationEmails ?? [],
      }
    : null,
});

/**
 * Is every garage actually working?
 *
 * Today's review found Ecotest and Moto Oil: both live, both with numbers assigned, both with
 * ZERO calls ever, and Ecotest already invoiced twice at £350 a month. Nothing surfaced either of
 * them — they were found by accident while looking at something else. Kestrels' missing FAQs and
 * six garages with stale agent config were found the same way.
 *
 * One row per garage with the handful of facts that say whether a customer is getting what they
 * pay for: are calls arriving, is the agent's config current, did anyone finish setup, and when
 * did they last pay. Sorted worst first, so the page opens on whatever is most wrong.
 */
router.get('/admin/health', authenticate, requireAdmin, async (_req, res) => {
  try {
    const garages = await prisma.garage.findMany({
      where: { archivedAt: null },
      select: {
        id: true, name: true, twilioNumber: true, isTestAccount: true,
        hasVoiceAccess: true, hasMessagingAccess: true, accessRestricted: true,
        subscriptionCostGbp: true, setupWizardCompleted: true,
        trialEndDate: true, archiveScheduledAt: true,
        agentConfiguration: { select: { agentType: true, agentScript: true, faqs: true, updatedAt: true } },
      },
    });

    const now = Date.now();
    const rows = await Promise.all(garages.map(async (g) => {
      const [lastCall, callsThisMonth, lastPaid, conversations] = await Promise.all([
        prisma.call.findFirst({
          where: { garageId: g.id }, orderBy: { createdAt: 'desc' }, select: { createdAt: true },
        }),
        prisma.call.count({
          where: { garageId: g.id, createdAt: { gte: new Date(now - 30 * 864e5) } },
        }),
        prisma.invoice.findFirst({
          where: { garageId: g.id, status: 'paid' }, orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        }),
        prisma.chatConversation.count({
          where: { garageId: g.id, updatedAt: { gte: new Date(now - 30 * 864e5) } },
        }),
      ]);

      const daysSinceCall = lastCall ? Math.floor((now - lastCall.createdAt.getTime()) / 864e5) : null;
      const faqCount = Array.isArray(g.agentConfiguration?.faqs) ? (g.agentConfiguration!.faqs as unknown[]).length : 0;

      // Worst first. A paying garage receiving nothing is the thing you most need to see, so it
      // outranks everything else; a garage with no number simply is not live yet and is not a
      // fault.
      const issues: string[] = [];
      const paying = Number(g.subscriptionCostGbp || 0) > 0;
      if (g.twilioNumber && g.hasVoiceAccess && lastCall === null) issues.push('never received a call');
      else if (g.twilioNumber && g.hasVoiceAccess && daysSinceCall !== null && daysSinceCall > 14) issues.push(`no calls for ${daysSinceCall} days`);
      if (!g.twilioNumber && g.hasVoiceAccess) issues.push('voice access but no number');
      if (faqCount === 0 && g.hasVoiceAccess) issues.push('no FAQs configured');
      if (!g.setupWizardCompleted) issues.push('setup never finished');
      if (g.accessRestricted) issues.push('access restricted');

      const severity =
        (paying && lastCall === null && g.twilioNumber ? 100 : 0) +
        (paying && daysSinceCall !== null && daysSinceCall > 14 ? 60 : 0) +
        (issues.length * 5);

      return {
        id: g.id,
        name: g.name,
        isTest: g.isTestAccount,
        monthly: Number(g.subscriptionCostGbp || 0),
        number: g.twilioNumber,
        agentType: g.agentConfiguration?.agentType ?? null,
        faqCount,
        callsThisMonth,
        conversationsThisMonth: conversations,
        lastCallAt: lastCall?.createdAt ?? null,
        daysSinceCall,
        lastPaidAt: lastPaid?.createdAt ?? null,
        daysSincePaid: lastPaid ? Math.floor((now - lastPaid.createdAt.getTime()) / 864e5) : null,
        setupComplete: g.setupWizardCompleted,
        accessRestricted: g.accessRestricted,
        trialEndDate: g.trialEndDate,
        leavingOn: g.archiveScheduledAt,
        configUpdatedAt: g.agentConfiguration?.updatedAt ?? null,
        issues,
        severity,
      };
    }));

    rows.sort((a, b) => b.severity - a.severity || a.name.localeCompare(b.name));
    res.json({ garages: rows, checkedAt: new Date() });
  } catch (error) {
    console.error('[ADMIN] health check failed:', error);
    res.status(500).json({ error: 'Could not build the health report' });
  }
});

/**
 * Schedule a leaver.
 *
 * A customer emails their notice, you set the date they are leaving, and the nightly
 * archiveDueGarages job switches them off that morning — voice and messaging access removed,
 * pricing zeroed, billing stopped, calls no longer answered. That engine already existed; there
 * was no way to set the date except editing the database by hand, which is why five garages have
 * been archived with no record of why they left.
 *
 * Service continues in full until the date arrives, so notice periods work the way a customer
 * expects. Pass leavingDate: null to cancel it if they change their mind.
 */
router.post('/admin/garages/:garageId/schedule-leaving', authenticate, requireAdmin, async (req, res) => {
  try {
    const { garageId } = req.params;
    const { leavingDate, reason } = req.body ?? {};

    const garage = await prisma.garage.findUnique({
      where: { id: garageId },
      select: { id: true, name: true, archivedAt: true },
    });
    if (!garage) return res.status(404).json({ error: 'Garage not found' });
    if (garage.archivedAt) return res.status(400).json({ error: 'That garage is already archived' });

    // Cancelling the notice.
    if (leavingDate === null) {
      await prisma.garage.update({
        where: { id: garageId },
        data: { archiveScheduledAt: null, cancellationReason: null, cancellationRequestedAt: null, cancellationRequestedBy: null },
      });
      console.log(`[LEAVER] ${req.user?.email} cancelled the notice on ${garage.name}`);
      return res.json({ success: true, name: garage.name, leavingDate: null });
    }

    const when = new Date(leavingDate);
    if (Number.isNaN(when.getTime())) {
      return res.status(400).json({ error: 'leavingDate must be a valid date, or null to cancel' });
    }
    // Archiving runs at 00:20, so a date without a time means "gone at the end of that day".
    when.setHours(23, 59, 0, 0);

    await prisma.garage.update({
      where: { id: garageId },
      data: {
        archiveScheduledAt: when,
        cancellationReason: typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 500) : null,
        cancellationRequestedAt: new Date(),
        cancellationRequestedBy: req.user?.email ?? null,
      },
    });
    console.log(`[LEAVER] ${req.user?.email} scheduled ${garage.name} to leave on ${when.toISOString().slice(0, 10)}${reason ? ` — ${reason}` : ''}`);
    res.json({ success: true, name: garage.name, leavingDate: when, reason: reason ?? null });
  } catch (error) {
    console.error('[ADMIN] failed to schedule leaving date:', error);
    res.status(500).json({ error: 'Could not set the leaving date' });
  }
});

/** Everyone with notice in, and everyone who has already gone, with the reason. */
router.get('/admin/leavers', authenticate, requireAdmin, async (_req, res) => {
  try {
    const leavers = await prisma.garage.findMany({
      where: { OR: [{ archiveScheduledAt: { not: null } }, { archivedAt: { not: null } }] },
      orderBy: [{ archiveScheduledAt: 'asc' }],
      select: {
        id: true, name: true, archiveScheduledAt: true, archivedAt: true,
        cancellationReason: true, cancellationRequestedAt: true, cancellationRequestedBy: true,
        subscriptionCostGbp: true,
      },
    });
    res.json({ leavers });
  } catch (error) {
    console.error('[ADMIN] failed to list leavers:', error);
    res.status(500).json({ error: 'Could not load leavers' });
  }
});

/**
 * What changed in a garage's agent settings, and who changed it.
 *
 * ?garageId= narrows it to one garage. Answers the question that had no answer before: a setting
 * looks different from how somebody left it — was that a person, a bad save, or the sync?
 */
router.get('/admin/config-changes', authenticate, requireAdmin, async (req, res) => {
  try {
    const take = Math.min(Number(req.query.limit) || 100, 500);
    const garageId = typeof req.query.garageId === 'string' ? req.query.garageId : undefined;
    // ?scope=garage for price, tier, access and trial changes; ?scope=agent_config for the
    // agent's own settings; omit it for both.
    const scope = typeof req.query.scope === 'string' ? req.query.scope : undefined;
    const changes = await prisma.agentConfigChange.findMany({
      where: {
        ...(garageId ? { garageId } : {}),
        ...(scope ? { scope } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take,
      select: {
        id: true, garageId: true, userEmail: true, changes: true, createdAt: true, scope: true,
        garage: { select: { name: true } },
      },
    });
    res.json({ changes });
  } catch (error) {
    console.error('[ADMIN] failed to list config changes:', error);
    res.status(500).json({ error: 'Could not load configuration history' });
  }
});

/**
 * Who signed in, when, and from where. Until this existed there was no record of a login at all,
 * so "who was in the portal on Tuesday" had no answer and repeated failures against one account
 * were invisible.
 *
 * ?email= filters to one account, ?failed=1 shows only rejected attempts.
 */
router.get('/admin/logins', authenticate, requireAdmin, async (req, res) => {
  try {
    const take = Math.min(Number(req.query.limit) || 100, 500);
    const email = typeof req.query.email === 'string' ? req.query.email.toLowerCase() : undefined;
    const failedOnly = req.query.failed === '1' || req.query.failed === 'true';
    const events = await prisma.loginEvent.findMany({
      where: {
        ...(email ? { email } : {}),
        ...(failedOnly ? { success: false } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take,
      select: {
        id: true, email: true, success: true, reason: true,
        ip: true, userAgent: true, createdAt: true, userId: true,
      },
    });
    res.json({ events });
  } catch (error) {
    console.error('[ADMIN] failed to list login events:', error);
    res.status(500).json({ error: 'Could not load login history' });
  }
});

/**
 * Lift a sign-in block before it expires on its own.
 *
 * Five wrong passwords locks an account for fifteen minutes. That is right for an attacker and
 * annoying for a customer on the phone who has just remembered their password, so there has to be
 * a way to release it without waiting.
 *
 * The failed attempts are marked rather than deleted: they stop counting toward the limit but stay
 * in the audit trail, so "why was this account locked" is still answerable afterwards.
 */
router.post('/admin/logins/unblock', authenticate, requireAdmin, async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ error: 'An email address is required' });
    }
    const since = new Date(Date.now() - 15 * 60 * 1000);
    const { count } = await prisma.loginEvent.updateMany({
      where: { email, success: false, createdAt: { gte: since }, NOT: { reason: 'cleared_by_admin' } },
      data: { reason: 'cleared_by_admin' },
    });
    console.log(`[ADMIN] ${req.user?.email} lifted the sign-in block on ${email} (${count} attempt(s) cleared)`);
    res.json({ success: true, email, cleared: count });
  } catch (error) {
    console.error('[ADMIN] failed to lift sign-in block:', error);
    res.status(500).json({ error: 'Could not lift the block' });
  }
});

/**
 * Sign a user out of every device.
 *
 * Tokens are stateless, so there is no session to delete — instead we stamp sessionsValidFrom and
 * every token issued before that moment stops being accepted. Used when someone must re-enter
 * their password, change it, or re-sign an agreement before carrying on.
 */
router.post('/admin/users/:userId/sign-out', authenticate, requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true } });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    const now = new Date();
    await prisma.user.update({ where: { id: userId }, data: { sessionsValidFrom: now } });
    // Drop the cached decision so the next request re-reads it rather than waiting out the TTL.
    forgetRevocation(userId);
    console.log(`[ADMIN] ${req.user?.email} signed out ${user.email} — all sessions invalidated`);
    res.json({ success: true, email: user.email, sessionsValidFrom: now });
  } catch (error) {
    console.error('[ADMIN] failed to sign user out:', error);
    res.status(500).json({ error: 'Could not sign the user out' });
  }
});

router.get('/admin/businesses', authenticate, requireAdmin, async (_req, res) => {
  // Archived garages are former customers — they stay in the database for their billing and call
  // history, but must not appear in the portal's lists. ?includeArchived=1 brings them back when
  // someone genuinely needs to look one up.
  const includeArchived = (_req.query as any)?.includeArchived === '1';
  const businesses = await prisma.business.findMany({
    include: {
      garages: {
        where: includeArchived ? {} : { archivedAt: null },
        include: { agentConfiguration: true },
        orderBy: { name: 'asc' },
      },
    },
    orderBy: { name: 'asc' },
  });

  // Get all users to find billing dates for each garage
  const users = await prisma.user.findMany({
    select: {
      garageAccessIds: true,
      nextBillingDate: true,
      billingCycleStartDate: true,
    },
  });

  // Create a map of garageId to billing info
  const garageBillingMap = new Map<string, { nextBillingDate: Date | null; billingDay: number | null }>();
  users.forEach(user => {
    user.garageAccessIds.forEach(garageId => {
      if (!garageBillingMap.has(garageId) && user.nextBillingDate) {
        garageBillingMap.set(garageId, {
          nextBillingDate: user.nextBillingDate,
          billingDay: user.nextBillingDate.getDate(),
        });
      }
    });
  });

  res.json({
    businesses: businesses.map((business) => ({
      id: business.id,
      name: business.name,
      contactName: business.contactName,
      contactEmail: business.contactEmail,
      contactPhone: business.contactPhone,
      contactRole: business.contactRole,
      branches: business.garages.map(garage => {
        const billingInfo = garageBillingMap.get(garage.id);
        return {
          ...formatBranch(garage),
          nextBillingDate: billingInfo?.nextBillingDate?.toISOString() ?? null,
          billingDay: billingInfo?.billingDay ?? null,
        };
      }),
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

  // Also grant access to the requesting admin user so they can immediately see the branch
  if (req.user?.userId) {
    const admin = await prisma.user.findUnique({
      where: { id: req.user.userId },
    });

    if (admin) {
      const currentIds = Array.isArray(admin.garageAccessIds) ? admin.garageAccessIds : [];
      const currentBranchRoles = sanitizeBranchRoles(admin.branchRoles);
      
      if (!currentIds.includes(garage.id)) {
        await prisma.user.update({
          where: { id: admin.id },
          data: {
            garageAccessIds: [...currentIds, garage.id],
            branchRoles: { ...currentBranchRoles, [garage.id]: 'MANAGER' },
          },
        });
      }
    }
  }

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

    const response = await fetch(`${onboardingEndpoint}/provision`, {
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

  // Remove branch access from all users (both garageAccessIds and branchRoles)
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
        const currentBranchRoles = sanitizeBranchRoles(user.branchRoles);
        const nextBranchRoles = { ...currentBranchRoles };

        // Remove all branch IDs from branchRoles
        branchIds.forEach((branchId) => {
          delete nextBranchRoles[branchId];
        });

        return prisma.user.update({
          where: { id: user.id },
          data: {
            garageAccessIds: nextIds,
            branchRoles: nextBranchRoles,
          },
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
      const currentBranchRoles = sanitizeBranchRoles(user.branchRoles);
      const nextBranchRoles = { ...currentBranchRoles };

      // Remove this branch from branchRoles
      delete nextBranchRoles[branchId];

      return prisma.user.update({
        where: { id: user.id },
        data: {
          garageAccessIds: nextIds,
          branchRoles: nextBranchRoles,
        },
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
  if (typeof parsed.data.mustSetupPayment === 'boolean') {
    prismaData.mustSetupPayment = parsed.data.mustSetupPayment;
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
  userRole: z.enum(['USER', 'MANAGER']).optional().default('USER'),
  subscriptionCostGbp: z.number().positive().max(10000),
  includedMinutes: z.number().int().min(0).max(100000),
  costPerMinuteGbp: z.number().min(0).max(100),
  vatRate: z.number().min(0).max(1).optional().default(0.2),
  // Optional routing pick from the quick-onboard modal — saves a trip into
  // Agent Configurations -> Routing after onboarding. Defaults to Assist-agent
  // (a.k.a. RMB-Assist on account 2) when omitted, matching self-serve.
  agentScript: z.enum([
    'Assist-agent',
    'GarageHive-agent',
    'tyresoft-agent',
    'receptionmate-agent-v3',
    'receptionmate-agent',
  ]).optional().default('Assist-agent'),
});

const DEFAULT_PASSWORD = 'Nomoremissedcalls';

// Batch-add branches to an existing business — multi-branch onboarding. Each branch is
// Google-enriched (address/phone/website/hours + seeded greeting & FAQs), gets billing +
// routing config, and (optionally) an existing user is granted MANAGER access to all of them
// so they bill together on the business's mandate.
// Provision a branch's Twilio number → SIP trunk + dispatch, and store it on the garage.
// Mirrors onboard step 5. Throws on failure so the caller can decide (batch treats it non-fatal).
async function provisionBranchTwilio(opts: { garageId: string; garageName: string; branchName: string; contactEmail?: string | null; twilioNumber: string; agentScript?: string | null; }) {
  const onboardingUrl = process.env.ONBOARDING_SERVICE_URL || 'http://localhost:3002';
  const agentName = opts.agentScript === 'tyresoft-agent' ? 'tyresoft-agent'
    : opts.agentScript === 'receptionmate-agent-v3' ? 'receptionmate-agent-v3'
      : opts.agentScript === 'MMH-agent' ? 'MMH-agent'
        : opts.agentScript === 'bookar-agent' ? 'bookar-agent'
          : opts.agentScript === 'Assist-agent' ? 'Assist-agent'
            : opts.agentScript === 'GarageHive-agent' ? 'GarageHive-agent'
              : 'receptionmate-agent';
  const account = accountForAgentScript(opts.agentScript);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (process.env.ONBOARDING_SECRET) headers['x-onboarding-secret'] = process.env.ONBOARDING_SECRET;
  const resp = await fetch(`${onboardingUrl}/provision`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      garageId: opts.garageId,
      garageName: opts.garageName,
      branchName: opts.branchName,
      contactEmail: opts.contactEmail || undefined,
      twilioNumber: opts.twilioNumber,
      agentName,
      account,
      triggeredAt: new Date().toISOString(),
    }),
  });
  if (!resp.ok) throw new Error(`Onboarding service failed: ${await resp.text()}`);
  await prisma.garage.update({ where: { id: opts.garageId }, data: { twilioNumber: opts.twilioNumber } });
}

const batchBranchSchema = z.object({
  branches: z.array(z.object({
    name: z.string().min(1).max(200),
    googlePlaceId: z.string().trim().max(400).optional(),
    twilioNumber: z.string().min(1).max(100).optional(),
    subscriptionCostGbp: z.number().min(0).max(10000).optional(),
    includedMinutes: z.number().int().min(0).max(100000).optional(),
    costPerMinuteGbp: z.number().min(0).max(100).optional(),
    vatRate: z.number().min(0).max(1).optional().default(0.2),
    messagingSubscriptionCostGbp: z.number().min(0).max(10000).optional(),
    includedMessages: z.number().int().min(0).max(1000000).optional(),
    costPerMessageGbp: z.number().min(0).max(100).optional(),
    agentScript: z.enum(['Assist-agent', 'GarageHive-agent', 'tyresoft-agent', 'receptionmate-agent-v3', 'receptionmate-agent']).optional().default('Assist-agent'),
  })).min(1).max(20),
  userId: z.string().optional(), // existing user to grant MANAGER access to the new branches
});

router.post('/admin/onboard', authenticateApiKey, requireAdmin, async (req, res) => {
  const parsed = completeOnboardingSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    // 0. Reject a duplicate email UP FRONT — before we create any business/garage/SIP trunk —
    // so onboarding can't 500 at the user-creation step (step 6) and leave an orphaned garage +
    // trunk + dispatch rule behind.
    const emailLc = parsed.data.userEmail.trim().toLowerCase();
    const existingUser = await prisma.user.findUnique({ where: { email: emailLc } });
    if (existingUser) {
      return res.status(409).json({
        error: `An account with the email "${emailLc}" already exists. Use a different email — a +alias such as name+demo@domain.com works for test accounts.`,
      });
    }

    // 1. Create business
    const business = await prisma.business.create({
      data: { name: parsed.data.businessName },
    });

    // 2. Create branch/garage with billing configuration so it's immediately billable.
    // (Default subscriptionCostGbp is 0, which previously caused confirm-mandate to skip
    //  setting billing dates because hasActiveGarages was false.)
    const garage = await prisma.garage.create({
      data: {
        name: parsed.data.branchName,
        businessId: business.id,
        subscriptionCostGbp: parsed.data.subscriptionCostGbp,
        includedMinutes: parsed.data.includedMinutes,
        costPerMinuteGbp: parsed.data.costPerMinuteGbp,
        vatRate: parsed.data.vatRate,
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
        // Routing pick from the quick-onboard modal (defaults to Assist-agent).
        agentScript: parsed.data.agentScript,
      },
    });

    // 4. Grant admin access
    await ensureAdminAccessToGarage(garage.id);

    // 5. Activate with Twilio (provision SIP trunk) - ONLY if Twilio number provided
    if (parsed.data.twilioNumber) {
      const onboardingUrl = process.env.ONBOARDING_SERVICE_URL || 'http://localhost:3002';
      // Get agent configuration to determine which agent version to use
      const agentConfig = await prisma.agentConfiguration.findUnique({
        where: { garageId: garage.id },
        select: { agentScript: true },
      });
      const agentName = agentConfig?.agentScript === 'tyresoft-agent'
          ? 'tyresoft-agent'
          : agentConfig?.agentScript === 'receptionmate-agent-v3'
            ? 'receptionmate-agent-v3'
            : agentConfig?.agentScript === 'MMH-agent'
              ? 'MMH-agent'
              : agentConfig?.agentScript === 'bookar-agent'
                ? 'bookar-agent'
                : agentConfig?.agentScript === 'Assist-agent'
                  ? 'Assist-agent'
                  : agentConfig?.agentScript === 'GarageHive-agent'
                    ? 'GarageHive-agent'
                    : 'receptionmate-agent';
      // Assist + GarageHive live on LiveKit Account 2. Without this the onboarding service
      // defaults to account1, so the SIP trunk lands on the wrong tenant and the phone rings
      // out — every Assist garage onboarded this way has had to be fixed by hand.
      const account = accountForAgentScript(agentConfig?.agentScript);
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
          account,
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
        email: parsed.data.userEmail.toLowerCase(),
        passwordHash,
        mustChangePassword: true,
        mustSetupPayment: true, // ENABLED for all new users
        garageAccessIds: [garage.id],
        role: parsed.data.userRole,
        branchRoles: { [garage.id]: 'MANAGER' },
      },
    });

    // 7. Send welcome email with login credentials
    const portalUrl = process.env.PORTAL_URL || 'https://portal.receptionmate.co.uk';
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

// PATCH /api/garages/:garageId/messaging-access - Toggle messaging subscription
router.patch(
  '/garages/:garageId/messaging-access',
  authenticate,
  requireAdmin,
  async (req, res) => {
    try {
      const { garageId } = req.params;
      const { hasMessagingAccess } = req.body;

      if (typeof hasMessagingAccess !== 'boolean') {
        return res.status(400).json({ error: 'hasMessagingAccess must be a boolean' });
      }

      const garage = await prisma.garage.update({
        where: { id: garageId },
        data: { hasMessagingAccess },
        select: {
          id: true,
          name: true,
          hasMessagingAccess: true,
        },
      });

      res.json({
        success: true,
        garage,
        message: `Messaging access ${hasMessagingAccess ? 'enabled' : 'disabled'} for ${garage.name}`,
      });
    } catch (error) {
      console.error('Failed to update messaging access:', error);
      res.status(500).json({ error: 'Failed to update messaging access' });
    }
  }
);

// DELETE /api/admin/invoices/:invoiceId - Delete an invoice (ReceptionMate staff only)
router.delete('/admin/invoices/:invoiceId', authenticate, requireAdmin, async (req, res) => {
  try {
    const { invoiceId } = req.params;

    // Check if invoice exists
    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        garage: {
          select: { name: true }
        }
      }
    });

    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    // Delete the invoice
    await prisma.invoice.delete({
      where: { id: invoiceId }
    });

    console.log(`✓ Invoice ${invoiceId} deleted by admin for ${invoice.garage.name}`);

    res.json({ success: true, message: 'Invoice deleted successfully' });
  } catch (error) {
    console.error('Failed to delete invoice:', error);
    res.status(500).json({ error: 'Failed to delete invoice' });
  }
});

// POST /api/admin/invoices/:invoiceId/credit - Credit/void an invoice (ReceptionMate staff only)
router.post('/admin/invoices/:invoiceId/credit', authenticate, requireAdmin, async (req, res) => {
  try {
    const { invoiceId } = req.params;
    const { reason } = req.body;

    if (!reason || typeof reason !== 'string') {
      return res.status(400).json({ error: 'Credit reason is required' });
    }

    // Check if invoice exists
    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        garage: {
          select: { name: true }
        }
      }
    });

    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    if (invoice.status === 'credited') {
      return res.status(400).json({ error: 'Invoice has already been credited' });
    }

    // Update invoice status to credited
    const updatedInvoice = await prisma.invoice.update({
      where: { id: invoiceId },
      data: {
        status: 'credited',
        // TODO: Add creditReason and creditedAt fields to schema
      }
    });

    console.log(`✓ Invoice ${invoiceId} credited by admin for ${invoice.garage.name} - Reason: ${reason}`);

    res.json({
      invoice: updatedInvoice,
      message: 'Invoice credited successfully'
    });
  } catch (error) {
    console.error('Failed to credit invoice:', error);
    res.status(500).json({ error: 'Failed to credit invoice' });
  }
});

// POST /api/admin/invoices/:invoiceId/mark-paid - Manually mark an invoice paid. For invoice-and-email
// customers who pay by their own Direct Debit / bank transfer (e.g. In'n'out) there is no payment
// webhook to flip the status, so this lets staff mark it when the money lands. If the invoice is part
// of a combined invoice (same business + billing period, e.g. In'n'out's 4 branches) the whole batch is
// marked in one click; otherwise just the single invoice.
router.post('/admin/invoices/:invoiceId/mark-paid', authenticate, requireAdmin, async (req, res) => {
  try {
    const { invoiceId } = req.params;
    const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }
    if (invoice.status === 'paid') {
      return res.status(400).json({ error: 'Invoice is already marked paid' });
    }

    const where: Prisma.InvoiceWhereInput = invoice.businessId
      ? { businessId: invoice.businessId, periodStart: invoice.periodStart, status: { in: ['pending', 'failed', 'draft'] } }
      : { id: invoice.id };
    const result = await prisma.invoice.updateMany({ where, data: { status: 'paid', paidAt: new Date() } });

    console.log(`✓ Invoice ${invoiceId} marked paid by admin (${result.count} record(s) in the combined invoice)`);
    res.json({ success: true, marked: result.count });
  } catch (error) {
    console.error('Failed to mark invoice paid:', error);
    res.status(500).json({ error: 'Failed to mark invoice as paid' });
  }
});

// POST /admin/billing/trigger-invoice-generation
// Manually trigger invoice generation for a garage/user
router.post('/billing/trigger-invoice-generation', authenticate, requireAdmin, async (req, res) => {
  try {
    const { garageId } = req.body;

    if (!garageId) {
      return res.status(400).json({ error: 'garageId is required' });
    }

    // Import billing function
    const { generateInvoicesForUser } = await import('../services/billing.js');

    // Find user with this garage
    const user = await prisma.user.findFirst({
      where: {
        garageAccessIds: { has: garageId }
      },
      select: {
        id: true,
        email: true,
        billingCycleStartDate: true,
        nextBillingDate: true,
        gocardlessMandateId: true,
      }
    });

    if (!user) {
      return res.status(404).json({ error: 'No user found with access to this garage' });
    }

    if (!user.gocardlessMandateId) {
      return res.status(400).json({ error: 'User does not have a GoCardless mandate set up' });
    }

    if (!user.billingCycleStartDate || !user.nextBillingDate) {
      return res.status(400).json({ error: 'User billing cycle not configured' });
    }

    // Generate invoices for this user
    const result = await generateInvoicesForUser(user.id);

    res.json({
      success: true,
      message: 'Invoice generation triggered',
      result
    });
  } catch (error) {
    console.error('Failed to trigger invoice generation:', error);
    res.status(500).json({
      error: 'Failed to trigger invoice generation',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// ── Account lock ───────────────────────────────────────────────────────────────────────────────
// Suspend (or restore) every customer login on a garage. Locks the USERS, because that is what
// stops sign-in: garage.accessRestricted is the arrears blocker and deliberately still lets
// people log in to pay. accessRestricted is set alongside so a locked account also stops serving
// call content.
//
// ReceptionMate staff accounts are never locked by this — they have access to many garages, and
// locking one fraudulent signup must not lock the team out of the other thirty.
const lockGarageSchema = z.object({
  locked: z.boolean(),
  reason: z.string().max(300).optional(),
});

router.post('/admin/garages/:garageId/lock', authenticate, requireAdmin, async (req, res) => {
  try {
    const parsed = lockGarageSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid request' });
    const { locked, reason } = parsed.data;
    const { garageId } = req.params;

    const garage = await prisma.garage.findUnique({ where: { id: garageId }, select: { id: true, name: true } });
    if (!garage) return res.status(404).json({ error: 'Garage not found' });

    const users = await prisma.user.findMany({
      where: { garageAccessIds: { has: garageId }, role: { not: 'RECEPTIONMATE_STAFF' } },
      select: { id: true, email: true },
    });

    await prisma.user.updateMany({
      where: { id: { in: users.map((u) => u.id) } },
      data: locked
        ? { lockedAt: new Date(), lockedReason: reason ?? null }
        : { lockedAt: null, lockedReason: null },
    });

    // Locking also withholds call content and raises the portal blocker; unlocking only clears
    // accessRestricted if there is no unpaid-invoice reason for it to stay on.
    if (locked) {
      await prisma.garage.update({ where: { id: garageId }, data: { accessRestricted: true } });
    } else {
      const g = await prisma.garage.findUnique({ where: { id: garageId }, select: { paymentFailedAt: true } });
      if (!g?.paymentFailedAt) {
        await prisma.garage.update({ where: { id: garageId }, data: { accessRestricted: false } });
      }
    }

    console.log(
      `[ADMIN] ${locked ? 'LOCKED' : 'UNLOCKED'} garage ${garage.name} (${garageId}) — ` +
        `${users.length} login(s): ${users.map((u) => u.email).join(', ') || 'none'}` +
        (locked && reason ? ` — reason: ${reason}` : ''),
    );

    res.json({ success: true, locked, garage: garage.name, usersAffected: users.map((u) => u.email) });
  } catch (error) {
    console.error('Failed to change account lock:', error);
    res.status(500).json({
      error: 'Failed to change account lock',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

router.post('/admin/businesses/:businessId/branches/batch', authenticateApiKey, requireAdmin, async (req, res) => {
  const { businessId } = req.params;
  const parsed = batchBranchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const business = await prisma.business.findUnique({ where: { id: businessId } });
  if (!business) return res.status(404).json({ error: 'Business not found.' });

  let grantUser = parsed.data.userId
    ? await prisma.user.findUnique({ where: { id: parsed.data.userId } })
    : null;
  if (parsed.data.userId && !grantUser) return res.status(404).json({ error: 'User not found.' });

  const created: { id: string; name: string; twilioNumber?: string | null; twilioWarning?: string }[] = [];
  for (const b of parsed.data.branches) {
    let place: Awaited<ReturnType<typeof fetchPlaceDetails>> = null;
    if (b.googlePlaceId) { try { place = await fetchPlaceDetails(b.googlePlaceId); } catch (e) { console.error('[BATCH-BRANCH] place lookup failed:', e); } }
    const greetingLine = `[timeofday], ${b.name}, Leah speaking, how can I help?`;
    const seededFaqs = industryDefaultFaqs(b.name);

    const garage = await prisma.garage.create({
      data: {
        name: b.name,
        businessId,
        ...(b.subscriptionCostGbp != null ? { subscriptionCostGbp: b.subscriptionCostGbp } : {}),
        ...(b.includedMinutes != null ? { includedMinutes: b.includedMinutes } : {}),
        ...(b.costPerMinuteGbp != null ? { costPerMinuteGbp: b.costPerMinuteGbp } : {}),
        vatRate: b.vatRate,
        ...(b.messagingSubscriptionCostGbp != null ? { messagingSubscriptionCostGbp: b.messagingSubscriptionCostGbp } : {}),
        ...(b.includedMessages != null ? { includedMessages: b.includedMessages } : {}),
        ...(b.costPerMessageGbp != null ? { costPerMessageGbp: b.costPerMessageGbp } : {}),
        ...((b.messagingSubscriptionCostGbp ?? 0) > 0 ? { hasMessagingAccess: true } : {}),
      },
    });
    await prisma.agentConfiguration.create({
      data: {
        garageId: garage.id,
        branchName: b.name,
        ...(place?.address ? { branchAddress: place.address } : {}),
        ...(place?.phone ? { phoneNumber: place.phone } : {}),
        ...(place?.website ? { websiteUrl: place.website } : {}),
        emailAddress: grantUser?.email,
        ...(place?.weeklyOpeningHours ? { weeklyOpeningHours: place.weeklyOpeningHours as Prisma.InputJsonValue } : {}),
        greetingLine,
        faqs: seededFaqs as unknown as Prisma.InputJsonValue,
        tonePreference: 'standard',
        responseSpeed: 'normal',
        interruptionSensitivity: 0.5,
        allowFastFitOnly: false,
        integrationProvider: 'none',
        agentScript: b.agentScript,
      },
    });
    await ensureAdminAccessToGarage(garage.id);

    if (grantUser) {
      const ids = Array.isArray(grantUser.garageAccessIds) ? grantUser.garageAccessIds : [];
      if (!ids.includes(garage.id)) {
        const roles = sanitizeBranchRoles(grantUser.branchRoles);
        grantUser = await prisma.user.update({
          where: { id: grantUser.id },
          data: { garageAccessIds: [...ids, garage.id], branchRoles: { ...roles, [garage.id]: 'MANAGER' } },
        });
      }
    }

    if (place?.website) {
      const site = place.website; const gid = garage.id; const bn = b.name;
      void (async () => {
        try { const f = await generateFaqsFromWebsite(site, bn); if (f.length >= 3) await prisma.agentConfiguration.update({ where: { garageId: gid }, data: { faqs: f as unknown as Prisma.InputJsonValue } }); }
        catch (e) { console.error('[BATCH-BRANCH] background FAQ failed:', e); }
      })();
    }
    // Twilio: provision this branch's number (SIP trunk + dispatch). Non-fatal — one bad
    // number must not roll back the other branches that already succeeded.
    let twilioWarning: string | undefined;
    if (b.twilioNumber) {
      try {
        await provisionBranchTwilio({ garageId: garage.id, garageName: garage.name, branchName: b.name, contactEmail: grantUser?.email, twilioNumber: b.twilioNumber, agentScript: b.agentScript });
      } catch (e) {
        console.error('[BATCH-BRANCH] Twilio provision failed:', e);
        twilioWarning = e instanceof Error ? e.message : 'Twilio provision failed';
      }
    }
    created.push({ id: garage.id, name: garage.name, twilioNumber: b.twilioNumber || null, twilioWarning });
  }

  res.status(201).json({ branches: created });
});

// Google Places type-ahead for the quick-onboard modal. Proxied server-side so the
// browser never needs a Maps key; reuses GOOGLE_PLACES_API_KEY.
router.get('/admin/places-autocomplete', authenticateApiKey, requireAdmin, async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  try {
    res.json({ predictions: await placesAutocomplete(q) });
  } catch {
    res.json({ predictions: [] });
  }
});

export default router;