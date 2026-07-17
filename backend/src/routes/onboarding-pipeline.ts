import type { Request, Response } from 'express';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../db.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { sendWelcomeEmail } from '../utils/email.js';
import { setOnboardingStage } from '../utils/onboardingStage.js';
import { findOpportunityCandidates, fetchOpportunity, highlevelConfigured } from '../services/highlevel.js';

// ---------------------------------------------------------------------------
// Sales-led onboarding pipeline (automate / tyresoft — Direct Debit deals).
//
// The flow these endpoints serve:
//   demo -> agreement sent -> signed -> we phone GarageHive/Tyresoft for the garage's
//   credentials -> agent built -> INVITE the customer -> they log in, do the setup wizard
//   and their DD mandate -> live.
//
// /admin/onboard creates the account silently (deferWelcomeEmail), and the customer is
// invited from here once there's actually something for them to log in to. Fetching the
// integration credentials is a phone call to a third party, so "agent built" is a manual
// button rather than something we can detect — that's by design, not a gap.
//
// Separate router (following billing-activation.ts) to keep admin.ts from growing further.
// ---------------------------------------------------------------------------

const router = Router();

// The standard starting password, same as admin.ts / public-signup.ts / onboarding.ts. Always
// paired with mustChangePassword: true — the customer sets their own on first login.
const DEFAULT_PASSWORD = 'Nomoremissedcalls';

const STAGES = [
  'awaiting_agreement',
  'awaiting_credentials',
  'agent_built',
  'invited',
  'mandate_pending',
  'live',
] as const;

/**
 * Resolve the CUSTOMER user for a garage.
 *
 * Deliberately NOT a bare `garageAccessIds has` findFirst: ensureAdminAccessToGarage adds every
 * RECEPTIONMATE_STAFF user to each new garage, and it runs BEFORE the customer's user is created
 * — so a naive findFirst tends to return a staff account. That exact bug is why billing.ts:733
 * was fixed ("non-deterministically picked staff/admin mandates instead of the customer's"), and
 * it still bites trackConfirmedBooking/activateTrialEndedGarages today.
 *
 * Prefer the branch MANAGER, exclude staff, and order deterministically.
 */
async function resolveCustomerUser(garageId: string) {
  const users = await prisma.user.findMany({
    where: {
      garageAccessIds: { has: garageId },
      role: { not: 'RECEPTIONMATE_STAFF' },
    },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      email: true,
      role: true,
      branchRoles: true,
      mustChangePassword: true,
      garageAccessIds: true,
    },
  });
  if (!users.length) return null;
  const manager = users.find((u) => {
    const roles = (u.branchRoles ?? {}) as Record<string, string>;
    return roles[garageId] === 'MANAGER';
  });
  return manager ?? users[0];
}

// --- Invite the customer: send their login now the agent is ready ------------
router.post(
  '/admin/garages/:garageId/invite',
  authenticate,
  requireAdmin,
  async (req: Request, res: Response) => {
    const { garageId } = req.params;
    const force = req.query.force === 'true';

    const garage = await prisma.garage.findUnique({
      where: { id: garageId },
      select: {
        id: true,
        name: true,
        onboardingStage: true,
        welcomeEmailSentAt: true,
        business: { select: { name: true } },
      },
    });
    if (!garage) return res.status(404).json({ error: 'Garage not found.' });

    // Guard 1: don't re-send by accident.
    if (garage.welcomeEmailSentAt && !force) {
      return res.status(409).json({
        error: `Already invited on ${garage.welcomeEmailSentAt.toISOString().slice(0, 10)}. Re-send with ?force=true — this issues a NEW password and invalidates their current one.`,
      });
    }

    const user = await resolveCustomerUser(garageId);
    if (!user) {
      return res.status(400).json({ error: 'No customer user found for this garage (staff accounts are excluded).' });
    }

    // Guard 2: never clobber a password someone is already using — and this one is ABSOLUTE,
    // deliberately not overridable by ?force=true. mustChangePassword only goes false once the
    // customer has logged in and set their own password; re-issuing would silently invalidate it
    // and lock a live user out until they find the email. This endpoint is an ONBOARDING action,
    // not a password-reset tool: if they've genuinely lost their password, use the admin
    // password-reset flow, which is what it's for. force exists only to re-send an invite to
    // someone who never got in.
    if (!user.mustChangePassword) {
      return res.status(409).json({
        error: `${user.email} has already logged in and set their own password — re-inviting would reset it and lock them out. Use the admin password-reset flow instead. (?force=true does not override this.)`,
      });
    }

    // Reset to the standard starting password and send that. The account may have been created
    // days ago and we never keep plaintext, so the password is always (re)set here rather than
    // replayed. mustChangePassword below is what secures the account — they choose their own on
    // first login, and the guard above refuses to run at all once they have.
    const password = DEFAULT_PASSWORD;
    const passwordHash = await bcrypt.hash(password, 10);
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, mustChangePassword: true },
    });

    const portalUrl = process.env.PORTAL_URL || 'https://portal.receptionmate.co.uk';
    const sent = await sendWelcomeEmail({
      to: user.email,
      businessName: garage.business?.name ?? garage.name,
      branchName: garage.name,
      email: user.email,
      password,
      portalUrl,
    }).catch((error) => {
      console.error('[PIPELINE] welcome email failed:', error);
      return false;
    });

    if (!sent) {
      // The password has already been rotated, so say so plainly — retrying is safe (it just
      // mints another), but the old one is gone either way.
      return res.status(502).json({
        error: `Password was reset but the welcome email failed to send to ${user.email}. Retry the invite.`,
      });
    }

    await prisma.garage.update({ where: { id: garageId }, data: { welcomeEmailSentAt: new Date() } });
    // Via the helper so the HighLevel mirror ("Invited — awaiting DD mandate") fires from the
    // single place that owns stage transitions.
    await setOnboardingStage(garageId, 'invited', { reason: 'welcome email sent' });
    const updated = await prisma.garage.findUniqueOrThrow({
      where: { id: garageId },
      select: { onboardingStage: true, welcomeEmailSentAt: true },
    });
    console.log(`[PIPELINE] invited ${user.email} for garage ${garage.name} (${garageId})`);

    return res.json({
      success: true,
      email: user.email,
      onboardingStage: updated.onboardingStage,
      welcomeEmailSentAt: updated.welcomeEmailSentAt,
    });
  },
);

// --- Move a deal along the pipeline -----------------------------------------
const stageSchema = z.object({ stage: z.enum(STAGES) });

router.post(
  '/admin/garages/:garageId/stage',
  authenticate,
  requireAdmin,
  async (req: Request, res: Response) => {
    const parsed = stageSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: `stage must be one of: ${STAGES.join(', ')}` });
    }
    const garage = await prisma.garage.findUnique({
      where: { id: req.params.garageId },
      select: { id: true, name: true, onboardingStage: true },
    });
    if (!garage) return res.status(404).json({ error: 'Garage not found.' });

    // NB: setOnboardingStage refuses to touch a garage already at 'live' (every pre-existing
    // garage on the estate is), so staff can't accidentally drag a live customer into the
    // pipeline from here — and moving TO 'live' is the one-way exit.
    await setOnboardingStage(garage.id, parsed.data.stage, { reason: 'moved by staff' });
    const updated = await prisma.garage.findUniqueOrThrow({
      where: { id: garage.id },
      select: { onboardingStage: true },
    });
    if (updated.onboardingStage !== parsed.data.stage) {
      return res.status(409).json({
        error: `${garage.name} is already live — it isn't in the onboarding pipeline.`,
        stage: updated.onboardingStage,
      });
    }
    return res.json({ success: true, from: garage.onboardingStage, to: updated.onboardingStage });
  },
);

// --- What's in flight --------------------------------------------------------
router.get('/admin/onboarding-pipeline', authenticate, requireAdmin, async (_req: Request, res: Response) => {
  const garages = await prisma.garage.findMany({
    where: { onboardingStage: { not: 'live' } },
    select: {
      id: true,
      name: true,
      onboardingStage: true,
      onboardingStageAt: true,
      welcomeEmailSentAt: true,
      ghlOpportunityId: true,
      requiresBookingActivation: true,
      bookingsRequiredForActivation: true,
      activationBookingsCount: true,
      trialEndDate: true,
      businessId: true,
      business: { select: { name: true, billingMethod: true, gocardlessMandateId: true } },
      agentConfiguration: { select: { agentType: true, agentScript: true, integrationProvider: true } },
    },
  });

  const rows = await Promise.all(
    garages.map(async (g) => {
      const user = await resolveCustomerUser(g.id);
      const agreement = await prisma.agreement.findFirst({
        where: { businessId: g.businessId ?? undefined },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          status: true,
          licences: true,
          licenceFeeGbp: true,
          signedAt: true,
          // Dates staff actually chase on: when it went out, and whether they've opened it.
          sentAt: true,
          sentToEmail: true,
          firstViewedAt: true,
          lastViewedAt: true,
          viewCount: true,
        },
      });
      const cfg = Array.isArray(g.agentConfiguration) ? g.agentConfiguration[0] : g.agentConfiguration;
      return {
        garageId: g.id,
        garageName: g.name,
        businessName: g.business?.name ?? null,
        stage: g.onboardingStage,
        billingMethod: g.business?.billingMethod ?? null,
        customerEmail: user?.email ?? null,
        customerUserId: user?.id ?? null,
        welcomeEmailSentAt: g.welcomeEmailSentAt,
        onboardingStageAt: g.onboardingStageAt,
        hasMandate: Boolean(g.business?.gocardlessMandateId),
        agreement,
        agentType: cfg?.agentType ?? null,
        agentScript: cfg?.agentScript ?? null,
        integrationProvider: cfg?.integrationProvider ?? null,
        ghlOpportunityId: g.ghlOpportunityId,
        bookingActivation: g.requiresBookingActivation
          ? { done: g.activationBookingsCount, required: g.bookingsRequiredForActivation }
          : null,
        trialEndDate: g.trialEndDate,
      };
    }),
  );

  // Map<string, number>: onboardingStage comes back from Prisma as a plain string (it's a String
  // column, not an enum), so the keys can't be narrowed to the STAGES union.
  const order = new Map<string, number>(STAGES.map((s, i) => [s as string, i]));
  rows.sort((a, b) => (order.get(a.stage) ?? 99) - (order.get(b.stage) ?? 99));
  return res.json({ stages: STAGES, count: rows.length, rows });
});

// --- HighLevel: which opportunity is this deal? -----------------------------
// Staff pick from this list rather than pasting an id (there's nowhere in the HL UI to copy one)
// or us matching on email (which silently picks the wrong opportunity — customers routinely have
// several, and the portal's own contact often has no email on it at all).
router.get('/admin/highlevel/opportunities', authenticate, requireAdmin, async (req: Request, res: Response) => {
  if (!highlevelConfigured()) return res.json({ configured: false, candidates: [], suggestedId: null });
  const email = typeof req.query.email === 'string' ? req.query.email : null;
  const phone = typeof req.query.phone === 'string' ? req.query.phone : null;
  if (!email && !phone) return res.status(400).json({ error: 'Provide email and/or phone.' });

  const candidates = await findOpportunityCandidates({ email, phone });

  // If this lead came through the marketing site we already stored its opportunity id when the
  // lead landed — no need to make anyone guess. (Phone/referral leads have no PendingSignup, so
  // they fall through to the picker.)
  let suggestedId: string | null = null;
  let suggestedSource: string | null = null;
  if (email) {
    const pending = await prisma.pendingSignup.findFirst({
      where: { email: email.toLowerCase(), ghlOpportunityId: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { ghlOpportunityId: true },
    });
    if (pending?.ghlOpportunityId) {
      const knownId = pending.ghlOpportunityId;
      if (candidates.some((c) => c.id === knownId)) {
        suggestedId = knownId;
        suggestedSource = 'their marketing-site enquiry';
      } else {
        // Not in the candidate list — either our HL contact is phone-only (an email search
        // wouldn't surface it) or the opportunity is gone. Fetch it to find out which.
        const one = await fetchOpportunity(knownId);
        if (one) {
          candidates.unshift(one);
          suggestedId = knownId;
          suggestedSource = 'their marketing-site enquiry';
        } else {
          // Deleted/merged in HL since the lead landed. Suggesting it would pre-select an option
          // that doesn't exist and look like it's linked when it isn't — say nothing and let
          // staff pick.
          console.warn(`[PIPELINE] stored HL opportunity ${knownId} for ${email} no longer exists — not suggesting it`);
        }
      }
    }
  }

  return res.json({ configured: true, count: candidates.length, candidates, suggestedId, suggestedSource });
});

// Link (or unlink) a garage to an existing HighLevel opportunity after the fact — for deals
// onboarded before this existed, or where staff skipped the picker.
const linkSchema = z.object({ ghlOpportunityId: z.string().trim().max(100).nullable() });
router.patch('/admin/garages/:garageId/highlevel', authenticate, requireAdmin, async (req: Request, res: Response) => {
  const parsed = linkSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'ghlOpportunityId must be a string or null.' });
  const garage = await prisma.garage.findUnique({ where: { id: req.params.garageId }, select: { id: true } });
  if (!garage) return res.status(404).json({ error: 'Garage not found.' });
  const updated = await prisma.garage.update({
    where: { id: garage.id },
    data: { ghlOpportunityId: parsed.data.ghlOpportunityId || null },
    select: { ghlOpportunityId: true },
  });
  return res.json({ success: true, ghlOpportunityId: updated.ghlOpportunityId });
});

export default router;
