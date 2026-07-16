import type { Request, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { prisma } from '../db.js';
import { sendEmail } from '../utils/email.js';
import { TEMPLATE_VERSION } from '../services/agreementTemplate.js';
import { pushSignupToHighlevel, updateContact } from '../services/highlevel.js';
import { ensureAdminAccessToGarage } from './admin.js';
import { fetchPlaceDetails } from '../utils/googlePlaces.js';
import { industryDefaultFaqs, generateFaqsFromWebsite } from '../utils/faqGenerator.js';
import { autoIngestWebsiteKnowledge } from './config.js';
import type { Prisma } from '@prisma/client';

const router = Router();

// Assist self-serve signup. IMPORTANT: no real account (Business/Garage/User/Agreement) is
// created here. Submitting details only creates/updates a PendingSignup and points the customer
// at the agreement. The account is created ONLY after they sign AND confirm a card — from the
// Stripe setup_intent.succeeded webhook, via createAccountFromPending() below.
const ASSIST_DEFAULTS = {
  subscriptionCostGbp: 200,
  includedMinutes: 400,
  costPerMinuteGbp: 0.25,
  vatRate: 0.2,
};

const PORTAL_URL = process.env.PORTAL_URL || 'https://portal.receptionmate.co.uk';
const PUBLIC_SIGNUP_TEMP_PASSWORD = 'Nomoremissedcalls';
const SIGN_LINK_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function escapeForEmail(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const publicSignupSchema = z.object({
  businessName: z.string().trim().min(2).max(200),
  email: z.string().trim().email().max(254),
  address: z.string().trim().max(500).optional(),
  googlePlaceId: z.string().trim().max(200).optional(),
  name: z.string().trim().min(2).max(120).optional(),
  // Contact phone captured on the details step (name / email / number).
  phone: z.string().trim().max(40).optional(),
  // When present, links to the prospect row created at the garage-search step (step 1).
  prospectId: z.string().trim().max(80).optional(),
});

/**
 * Create the real Assist account from a completed (signed + carded) PendingSignup.
 * Idempotent — safe to call more than once. Called ONLY from the Stripe
 * setup_intent.succeeded webhook, never before the card is confirmed.
 */
export async function createAccountFromPending(
  pendingId: string,
): Promise<{ garageId: string; garageName: string; userEmail: string } | null> {
  const pending = await prisma.pendingSignup.findUnique({ where: { id: pendingId } });
  if (!pending) return null;
  if (pending.createdGarageId) {
    const g = await prisma.garage.findUnique({ where: { id: pending.createdGarageId }, select: { id: true, name: true } });
    return g ? { garageId: g.id, garageName: g.name, userEmail: pending.email } : null;
  }

  const businessName = pending.businessName;
  const normalizedEmail = pending.email.toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (existing) {
    console.error('[PUBLIC_SIGNUP] createAccountFromPending: email already has an account:', normalizedEmail);
    return null;
  }

  const greetingLine = `[timeofday], ${businessName}, Leah speaking, how can I help?`;
  const seededFaqs = industryDefaultFaqs(businessName);

  // Self-serve pays by Stripe card, never Direct Debit — mark the rail at creation so the
  // payment gate and mandate-chasing never treat this customer as a DD account.
  const business = await prisma.business.create({
    data: { name: businessName, billingMethod: 'stripe_card' },
  });
  const garage = await prisma.garage.create({
    data: {
      name: businessName,
      businessId: business.id,
      subscriptionCostGbp: ASSIST_DEFAULTS.subscriptionCostGbp,
      includedMinutes: ASSIST_DEFAULTS.includedMinutes,
      costPerMinuteGbp: ASSIST_DEFAULTS.costPerMinuteGbp,
      vatRate: ASSIST_DEFAULTS.vatRate,
      stripeCustomerId: pending.stripeCustomerId,
      stripeSubscriptionId: pending.stripeSubscriptionId,
      trialEndsAt: pending.trialEndsAt,
      ghlOpportunityId: pending.ghlOpportunityId,
    },
  });
  await prisma.agentConfiguration.create({
    data: {
      garageId: garage.id,
      branchName: businessName,
      branchAddress: pending.branchAddress,
      phoneNumber: pending.phoneNumber,
      websiteUrl: pending.websiteUrl,
      emailAddress: normalizedEmail,
      ...(pending.weeklyOpeningHours ? { weeklyOpeningHours: pending.weeklyOpeningHours as Prisma.InputJsonValue } : {}),
      greetingLine,
      faqs: seededFaqs as unknown as Prisma.InputJsonValue,
      tonePreference: 'standard',
      responseSpeed: 'normal',
      interruptionSensitivity: 0.5,
      allowFastFitOnly: false,
      integrationProvider: 'none',
      agentType: 'assist',
      agentScript: 'Assist-agent',
    },
  });
  const passwordHash = await bcrypt.hash(PUBLIC_SIGNUP_TEMP_PASSWORD, 10);
  const user = await prisma.user.create({
    data: {
      email: normalizedEmail,
      passwordHash,
      mustChangePassword: true,
      mustSetupPayment: false, // paid via Stripe card — skip the GoCardless DD gate
      garageAccessIds: [garage.id],
      role: 'MANAGER',
      branchRoles: { [garage.id]: 'MANAGER' },
    },
  });
  await prisma.agreement.create({
    data: {
      type: 'saas',
      version: pending.agreementVersion || TEMPLATE_VERSION,
      status: 'signed',
      userId: user.id,
      businessId: business.id,
      clientName: businessName,
      setupFeeGbp: 0,
      licenceFeeGbp: ASSIST_DEFAULTS.subscriptionCostGbp,
      centresCount: 1,
      licences: ['assist'],
      goLiveDate: new Date(),
      signedAt: pending.signedAt ?? new Date(),
      signedByName: pending.signedByName,
      signedByEmail: normalizedEmail,
      signedFromIp: pending.signedFromIp,
      signedUserAgent: pending.signedUserAgent,
      signatureImage: pending.signatureImage,
      templateSnapshot: pending.templateSnapshot || '',
    },
  });

  await ensureAdminAccessToGarage(garage.id).catch((err) =>
    console.error('[PUBLIC_SIGNUP] ensureAdminAccessToGarage failed:', err),
  );
  await prisma.pendingSignup.update({
    where: { id: pending.id },
    data: { status: 'completed', createdGarageId: garage.id },
  });

  // Background: upgrade the seeded FAQs from the garage's website + ingest into the KB.
  if (pending.websiteUrl) {
    const site = pending.websiteUrl;
    void (async () => {
      try {
        const aiFaqs = await generateFaqsFromWebsite(site, businessName);
        if (aiFaqs.length >= 3) {
          await prisma.agentConfiguration.update({
            where: { garageId: garage.id },
            data: { faqs: aiFaqs as unknown as Prisma.InputJsonValue },
          });
        }
      } catch (err) {
        console.error('[PUBLIC_SIGNUP] background FAQ generation failed:', err);
      }
      await autoIngestWebsiteKnowledge(garage.id, site).catch(() => {});
    })();
  }

  console.log(`[PUBLIC_SIGNUP] account created from pending=${pending.id} → garage=${garage.id} (${businessName})`);
  return { garageId: garage.id, garageName: businessName, userEmail: normalizedEmail };
}

router.post('/public-signup', async (req: Request, res: Response) => {
  const parsed = publicSignupSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: 'invalid_request', details: parsed.error.flatten() });
  }

  const { businessName, email, address, googlePlaceId, name, phone, prospectId } = parsed.data;
  const normalizedEmail = email.toLowerCase();

  try {
    // Reject duplicate emails — direct the user to log in instead.
    const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (existing) {
      return res.status(409).json({
        success: false,
        error: 'email_in_use',
        message: 'This email already has an account. Please sign in instead.',
        loginUrl: `${PORTAL_URL}/login`,
      });
    }

    // Reuse the prospect row from step 1 if present; else create a fresh pending (direct signup).
    let pending =
      prospectId ? await prisma.pendingSignup.findUnique({ where: { id: prospectId } }) : null;

    if (pending && pending.status !== 'completed') {
      pending = await prisma.pendingSignup.update({
        where: { id: pending.id },
        data: { name: name ?? pending.name, email: normalizedEmail, contactPhone: phone ?? pending.contactPhone, product: 'assist', status: 'pending' },
      });
      // Enrich the existing Abandoned-checkout HL contact with the real name + email + phone
      // (replaces the placeholder from the garage-search step) — updates by id, no duplicate.
      if (pending.ghlContactId) {
        void updateContact(pending.ghlContactId, { name: name || businessName, email: normalizedEmail, phone: phone || undefined })
          .catch((e) => console.error('[PUBLIC_SIGNUP] HL contact enrich failed:', e));
      }
    } else {
      const place = googlePlaceId ? await fetchPlaceDetails(googlePlaceId) : null;
      const signToken = randomBytes(32).toString('base64url');
      pending = await prisma.pendingSignup.create({
        data: {
          businessName,
          email: normalizedEmail,
          name: name ?? null,
          googlePlaceId: googlePlaceId ?? null,
          branchAddress: place?.address || address || null,
          phoneNumber: place?.phone || null,
          websiteUrl: place?.website || null,
          ...(place?.weeklyOpeningHours ? { weeklyOpeningHours: place.weeklyOpeningHours as Prisma.InputJsonValue } : {}),
          signToken,
          status: 'pending',
          product: 'assist',
          expiresAt: new Date(Date.now() + SIGN_LINK_TTL_MS),
        },
      });
      // Abandoned-checkout opportunity for direct signups that skipped the prospect step.
      const p = pending;
      void pushSignupToHighlevel({
        name: name || businessName,
        email: normalizedEmail,
        phone: place?.phone ?? undefined,
        companyName: businessName,
        website: place?.website ?? undefined,
        source: 'website-getstarted-assist',
        tags: ['website-signup', 'abandoned-checkout', 'assist'],
        opportunityName: `${businessName} — Assist`,
        kind: 'abandoned',
      }).then((r) => {
        if (r.opportunityId || r.contactId) {
          return prisma.pendingSignup.update({ where: { id: p.id }, data: { ghlOpportunityId: r.opportunityId, ghlContactId: r.contactId } });
        }
      }).catch((e) => console.error('[PUBLIC_SIGNUP] HL abandoned opp failed:', e));
    }

    const signUrl = `${PORTAL_URL}/agreement/sign?token=${encodeURIComponent(pending.signToken)}`;

    // Backup "review & sign" email — the marketing site redirects straight to signUrl, so the
    // common path doesn't touch the inbox. No account details are revealed until they've paid.
    const subject = 'Finish setting up your ReceptionMate account';
    const html = `
      <div style="font-family:Inter,system-ui,sans-serif;max-width:560px;margin:0 auto;color:#0f172a;">
        <h2 style="color:#3426cf;margin:0 0 12px;">Welcome to ReceptionMate</h2>
        <p>Hi ${escapeForEmail(businessName)},</p>
        <p>Thanks for getting started. To finish, review and sign your service agreement and add your card to start your 14-day free trial — you won't be charged today.</p>
        <p style="text-align:center;margin:28px 0;">
          <a href="${signUrl}" style="display:inline-block;background:#3426cf;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;">Review, sign &amp; start free trial</a>
        </p>
        <p style="color:#94a3b8;font-size:13px;">This link is valid for 14 days.</p>
      </div>`;
    const text = `Welcome to ReceptionMate!\n\nReview and sign your agreement and add your card to start your 14-day free trial (no charge today):\n${signUrl}\n\nThis link is valid for 14 days.`;
    await sendEmail({ to: [normalizedEmail], subject, html, text }).catch((error) => {
      console.error('[PUBLIC_SIGNUP] sign email failed:', error);
    });

    console.log(`[PUBLIC_SIGNUP] pending ready to sign: ${normalizedEmail} → ${businessName} (pending=${pending.id})`);
    return res.status(201).json({ success: true, signUrl, businessName });
  } catch (error) {
    console.error('[PUBLIC_SIGNUP] failed:', error);
    return res.status(500).json({ success: false, error: 'server_error' });
  }
});

// POST /api/public/signup-complete — called by the card form the instant Stripe confirms the
// card. Creates the account from the pending row (idempotent) and returns a one-time set-password
// token so the customer lands on the "Choose a password" page and is auto-logged-in on submit.
const completeSchema = z.object({ pendingSignupId: z.string().trim().min(1).max(80) });
router.post('/public/signup-complete', async (req: Request, res: Response) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const parsed = completeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'invalid_request' });
  try {
    const created = await createAccountFromPending(parsed.data.pendingSignupId);
    if (!created) return res.status(409).json({ ok: false, error: 'could_not_create' });
    const resetToken = randomBytes(32).toString('hex');
    await prisma.user.update({
      where: { email: created.userEmail },
      data: { resetToken, resetTokenExpiry: new Date(Date.now() + 60 * 60 * 1000) },
    });
    return res.json({ ok: true, resetToken });
  } catch (err) {
    console.error('[PUBLIC_SIGNUP] signup-complete failed:', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

export default router;
