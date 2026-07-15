import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import twilio from 'twilio';
import { prisma } from '../db.js';

// ---------------------------------------------------------------------------
// Self-serve "Connect-only" signup (WhatsApp messaging, no voice tier).
//
// Driven from the /mot marketing landing page. Two steps, both PUBLIC:
//   POST /api/public/connect-signup/start   -> validate + send an SMS OTP (Twilio Verify)
//   POST /api/public/connect-signup/verify  -> check the OTP, then create the account
//
// This file is fully additive and self-contained: it does NOT touch the existing
// Assist signup (public-signup), admin onboarding, auth, or any existing WhatsApp
// connection. A Connect-only garage is just a Garage with hasMessagingAccess=true
// and a 1-month trialEndDate, no voice provisioning. No card is taken — the SMS OTP
// is the anti-fraud gate, and Direct Debit is set up in-portal before the trial ends
// (User.mustSetupPayment=true, same pattern as the live Assist flow).
// ---------------------------------------------------------------------------

const router = Router();

// Connect plan economics: £250/mo including 500 conversation credits; additional
// credits are charged at £0.20 each. The 1-month trial includes the same 500 credits.
// Metered credit counting + overage billing is wired in Phase 3 (trial -> Direct Debit).
// During the trial nothing is charged (no DD mandate exists), so the subscription figure
// only takes effect once the garage sets up Direct Debit at trial end.
const CONNECT_DEFAULTS = {
  subscriptionCostGbp: Number(process.env.CONNECT_MONTHLY_GBP ?? 250),
  includedConversationCredits: Number(process.env.CONNECT_INCLUDED_CREDITS ?? 500),
  extraCreditGbp: Number(process.env.CONNECT_EXTRA_CREDIT_GBP ?? 0.2),
  includedMinutes: 0,       // Connect-only: no voice
  costPerMinuteGbp: 0,
  vatRate: 0.2,
};

const TRIAL_DAYS = Number(process.env.CONNECT_TRIAL_DAYS ?? 30);

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN,
);
const VERIFY_SID = process.env.TWILIO_VERIFY_SERVICE_SID;

// Normalise a UK-entered mobile to E.164 (+44…). Accepts "07…", "447…", "+447…".
function toE164UK(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, '');
  if (/^\+44\d{9,10}$/.test(digits)) return digits;
  if (/^44\d{9,10}$/.test(digits)) return '+' + digits;
  if (/^0\d{9,10}$/.test(digits)) return '+44' + digits.slice(1);
  if (/^\+\d{10,15}$/.test(digits)) return digits; // already E.164 (non-UK)
  return null;
}

const startSchema = z.object({
  businessName: z.string().trim().min(2).max(200),
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(254),
  mobile: z.string().trim().min(7).max(20),
});

const verifySchema = startSchema.extend({
  code: z.string().trim().min(4).max(10),
  password: z.string().min(8).max(200),
  googlePlaceId: z.string().trim().max(200).optional(),
  address: z.string().trim().max(500).optional(),
});

// --- Step 1: validate + send the SMS OTP -----------------------------------
router.post('/start', async (req, res) => {
  const parsed = startSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: 'invalid_request', details: parsed.error.flatten() });
  }
  if (!VERIFY_SID) {
    console.error('[CONNECT_SIGNUP] TWILIO_VERIFY_SERVICE_SID is not configured');
    return res.status(500).json({ success: false, error: 'verify_not_configured' });
  }
  const email = parsed.data.email.toLowerCase();
  const mobile = toE164UK(parsed.data.mobile);
  if (!mobile) {
    return res.status(400).json({ success: false, error: 'invalid_mobile', message: 'Enter a valid UK mobile number.' });
  }
  try {
    // Reject duplicate emails up front — direct them to log in instead.
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(409).json({
        success: false,
        error: 'email_in_use',
        message: 'This email already has an account. Please sign in instead.',
      });
    }
    await twilioClient.verify.v2.services(VERIFY_SID).verifications.create({ to: mobile, channel: 'sms' });
    const masked = mobile.slice(0, 3) + '•••••' + mobile.slice(-3);
    return res.json({ success: true, mobileMasked: masked });
  } catch (error) {
    console.error('[CONNECT_SIGNUP] start failed:', error);
    return res.status(500).json({ success: false, error: 'server_error' });
  }
});

// --- Step 2: check the OTP, then create the Connect account ------------------
router.post('/verify', async (req, res) => {
  const parsed = verifySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: 'invalid_request', details: parsed.error.flatten() });
  }
  if (!VERIFY_SID) {
    return res.status(500).json({ success: false, error: 'verify_not_configured' });
  }
  const { businessName, name, code, password, googlePlaceId, address } = parsed.data;
  const email = parsed.data.email.toLowerCase();
  const mobile = toE164UK(parsed.data.mobile);
  if (!mobile) {
    return res.status(400).json({ success: false, error: 'invalid_mobile' });
  }
  try {
    // 1. Check the SMS OTP.
    const check = await twilioClient.verify.v2.services(VERIFY_SID)
      .verificationChecks.create({ to: mobile, code });
    if (check.status !== 'approved') {
      return res.status(401).json({ success: false, error: 'invalid_code', message: 'That code is not correct or has expired.' });
    }

    // 2. Re-check email uniqueness (race between start and verify).
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(409).json({ success: false, error: 'email_in_use', message: 'This email already has an account. Please sign in instead.' });
    }

    // 3. Business
    const business = await prisma.business.create({
      data: { name: businessName, contactName: name, contactEmail: email, contactPhone: mobile },
    });

    // 4. Garage — Connect-only: messaging ON, 1-month trial, no voice provisioning.
    const trialEndDate = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
    const garage = await prisma.garage.create({
      data: {
        name: businessName,
        businessId: business.id,
        hasMessagingAccess: true,
        trialEndDate,
        subscriptionCostGbp: CONNECT_DEFAULTS.subscriptionCostGbp,
        includedMinutes: CONNECT_DEFAULTS.includedMinutes,
        costPerMinuteGbp: CONNECT_DEFAULTS.costPerMinuteGbp,
        vatRate: CONNECT_DEFAULTS.vatRate,
      },
    });

    // 5. AgentConfiguration — minimal, for inbound WhatsApp chat replies. Voice
    //    fields default harmlessly (agentType 'assist' is only read by voice routing,
    //    which never fires because there's no Twilio number).
    await prisma.agentConfiguration.create({
      data: {
        garageId: garage.id,
        branchName: businessName,
        branchAddress: address || null,
        emailAddress: email,
        phoneNumber: mobile,
        greetingLine: `Hi, thanks for messaging ${businessName} — how can we help?`,
      },
    });

    // 6. User — MANAGER, with the password they chose. mustSetupPayment=false: this is a
    //    no-card trial, so we do NOT force Direct Debit setup up front — DD is prompted near
    //    the end of the free month (Phase 3). Forcing payment now would contradict "no card".
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        mustChangePassword: false,
        mustSetupPayment: false,
        garageAccessIds: [garage.id],
        role: 'MANAGER',
        branchRoles: { [garage.id]: 'MANAGER' },
      },
    });

    console.log(`[CONNECT_SIGNUP] created Connect trial: ${email} -> ${businessName} (garage=${garage.id})`);

    // 7. Auto-login: mint the same session token /api/auth/login issues, so the marketing
    //    site can drop the user straight into the portal (via /welcome) with no password
    //    re-entry. Returned to the browser and carried in the URL fragment (never logged).
    const branchRoles = { [garage.id]: 'MANAGER' };
    let session: any = null;
    const secret = process.env.JWT_SECRET;
    if (secret) {
      const token = jwt.sign(
        { userId: user.id, email, role: 'MANAGER', branchRoles, garageIds: [garage.id] },
        secret,
        { expiresIn: '12h' },
      );
      session = {
        token,
        userId: user.id,
        email,
        role: 'MANAGER',
        branchRoles,
        garageId: garage.id,
        garages: [{ id: garage.id, name: businessName }],
      };
    }
    return res.status(201).json({ success: true, email, businessName, session });
  } catch (error) {
    console.error('[CONNECT_SIGNUP] verify failed:', error);
    return res.status(500).json({ success: false, error: 'server_error' });
  }
});

export default router;
