import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import twilio from 'twilio';
import { randomBytes } from 'crypto';
import { prisma } from '../db.js';
import { pushSignupToHighlevel, updateContact, updateOpportunity, TRIAL_LIVE_STAGE_ID } from '../services/highlevel.js';
import { sendOpsSms } from '../utils/opsAlerts.js';
import { sendEmail } from '../utils/email.js';

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

// --- Rate limiting -----------------------------------------------------------------------
// /start sends a real SMS through Twilio Verify, so an unthrottled public endpoint is both a
// direct cost leak and a way to text-bomb a number the caller doesn't own; /verify needs a cap
// so a 6-digit code can't be brute-forced. In-memory state is sufficient and deliberate: pm2
// runs this backend as a SINGLE fork-mode process, so there's nothing to share across workers.
// If it's ever moved to cluster mode or a second instance, this must move to Redis/Postgres.
type Bucket = { count: number; windowStart: number; last: number };
const startByNumber = new Map<string, Bucket>();
const startByIp = new Map<string, Bucket>();
const verifyByNumber = new Map<string, Bucket>();

const RESEND_COOLDOWN_MS = 60_000;                    // between two SMS to the same number
const START_NUMBER_MAX = 5, START_NUMBER_WINDOW = 24 * 60 * 60 * 1000;
const START_IP_MAX = 10, START_IP_WINDOW = 60 * 60 * 1000;
const VERIFY_MAX = 8, VERIFY_WINDOW = 15 * 60 * 1000;

/** Fixed-window counter. Returns null when allowed, else seconds until the window resets. */
function hit(map: Map<string, Bucket>, key: string, max: number, windowMs: number): number | null {
  const now = Date.now();
  const b = map.get(key);
  if (!b || now - b.windowStart >= windowMs) {
    map.set(key, { count: 1, windowStart: now, last: now });
    return null;
  }
  b.last = now;
  if (b.count >= max) return Math.max(1, Math.ceil((b.windowStart + windowMs - now) / 1000));
  b.count += 1;
  return null;
}

// Sweep hourly so the maps can't grow without bound. unref() so this never holds the process open.
setInterval(() => {
  const cutoff = Date.now() - START_NUMBER_WINDOW;
  for (const map of [startByNumber, startByIp, verifyByNumber]) {
    for (const [k, b] of map) if (b.last < cutoff) map.delete(k);
  }
}, 60 * 60 * 1000).unref();

/** Client IP — nginx sits in front and `trust proxy` is not set, so req.ip is the loopback. */
function clientIp(req: Request): string {
  const forwarded = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim();
  return forwarded || req.ip || 'unknown';
}

const SIGN_LINK_TTL_MS = 14 * 24 * 60 * 60 * 1000;

const startSchema = z.object({
  businessName: z.string().trim().min(2).max(200),
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(254),
  mobile: z.string().trim().min(7).max(20),
  // PendingSignup id from the /mot garage picker, when they came through it.
  prospectId: z.string().trim().max(80).optional(),
});

const verifySchema = startSchema.extend({
  code: z.string().trim().min(4).max(10),
  password: z.string().min(8).max(200),
  googlePlaceId: z.string().trim().max(200).optional(),
  address: z.string().trim().max(500).optional(),
  // PendingSignup id from the /mot garage picker's prospect call. When present we promote
  // that existing HighLevel opportunity instead of creating a second one for the same garage.
  prospectId: z.string().trim().max(80).optional(),
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
  const { businessName, name, prospectId } = parsed.data;
  const email = parsed.data.email.toLowerCase();
  const mobile = toE164UK(parsed.data.mobile);
  if (!mobile) {
    return res.status(400).json({ success: false, error: 'invalid_mobile', message: 'Enter a valid UK mobile number.' });
  }
  // Throttle before any Twilio spend. Cooldown first so a double-click gets the friendly
  // "wait a moment" rather than burning one of the five daily sends.
  const prev = startByNumber.get(mobile);
  if (prev && Date.now() - prev.last < RESEND_COOLDOWN_MS) {
    const wait = Math.ceil((RESEND_COOLDOWN_MS - (Date.now() - prev.last)) / 1000);
    res.setHeader('Retry-After', String(wait));
    return res.status(429).json({
      success: false, error: 'too_soon', retryAfter: wait,
      message: `Please wait ${wait} second${wait === 1 ? '' : 's'} before requesting another code.`,
    });
  }
  const ipWait = hit(startByIp, clientIp(req), START_IP_MAX, START_IP_WINDOW);
  if (ipWait !== null) {
    console.warn(`[CONNECT_SIGNUP] rate-limited /start by ip=${clientIp(req)}`);
    res.setHeader('Retry-After', String(ipWait));
    return res.status(429).json({
      success: false, error: 'rate_limited', retryAfter: ipWait,
      message: 'Too many sign-up attempts. Please try again later.',
    });
  }
  const numWait = hit(startByNumber, mobile, START_NUMBER_MAX, START_NUMBER_WINDOW);
  if (numWait !== null) {
    console.warn(`[CONNECT_SIGNUP] rate-limited /start by number=${mobile.slice(-4)}`);
    res.setHeader('Retry-After', String(numWait));
    return res.status(429).json({
      success: false, error: 'rate_limited', retryAfter: numWait,
      message: 'Too many codes requested for that number today. Please try again tomorrow.',
    });
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
    // Capture the lead BEFORE sending the code. Until now this step stored nothing, so anyone
    // who entered their details and never typed the SMS code vanished without trace — which is
    // most of them. Persisting here means a drop-off is still a contactable lead. Deliberately
    // before the Twilio call: if the SMS fails we would rather keep the details than lose them.
    let leadId: string | null = null;
    try {
      const existingRow = prospectId
        ? await prisma.pendingSignup.findUnique({ where: { id: prospectId } })
        : null;
      const row = existingRow
        ? await prisma.pendingSignup.update({
            where: { id: existingRow.id },
            data: { name, email, contactPhone: mobile, businessName, product: 'connect', status: 'pending' },
          })
        : await prisma.pendingSignup.create({
            data: {
              businessName,
              email,
              name,
              contactPhone: mobile,
              product: 'connect',
              status: 'pending',
              signToken: randomBytes(32).toString('base64url'),
              expiresAt: new Date(Date.now() + SIGN_LINK_TTL_MS),
            },
          });
      leadId = row.id;
      // Now that we have an email this lead is chaseable, so it can go to HighLevel — the
      // garage-picker step deliberately doesn't sync (no email yet, see public-prospect.ts).
      void (async () => {
        try {
          if (row.ghlContactId) {
            await updateContact(row.ghlContactId, { name, email, phone: mobile });
          } else {
            const r = await pushSignupToHighlevel({
              name, email, phone: mobile, companyName: businessName,
              source: 'website-mot-connect', tags: ['website-signup', 'connect', 'abandoned-checkout'],
              opportunityName: `${businessName} — Connect trial`,
              kind: 'abandoned',
            });
            if (r.opportunityId || r.contactId) {
              await prisma.pendingSignup.update({
                where: { id: row.id },
                data: { ghlOpportunityId: r.opportunityId, ghlContactId: r.contactId },
              });
            }
          }
        } catch (e) {
          console.error('[CONNECT_SIGNUP] HL lead capture failed:', e);
        }
      })();
    } catch (e) {
      // Never block the signup on lead capture.
      console.error('[CONNECT_SIGNUP] lead capture failed:', e);
    }

    await twilioClient.verify.v2.services(VERIFY_SID).verifications.create({ to: mobile, channel: 'sms' });
    const masked = mobile.slice(0, 3) + '•••••' + mobile.slice(-3);
    // Hand the id back so /verify can complete THIS row rather than creating another.
    return res.json({ success: true, mobileMasked: masked, prospectId: leadId ?? prospectId ?? undefined });
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
  const { businessName, name, code, password, googlePlaceId, address, prospectId } = parsed.data;
  const email = parsed.data.email.toLowerCase();
  const mobile = toE164UK(parsed.data.mobile);
  if (!mobile) {
    return res.status(400).json({ success: false, error: 'invalid_mobile' });
  }
  // Cap code guesses so a 6-digit OTP can't be brute-forced.
  const codeWait = hit(verifyByNumber, mobile, VERIFY_MAX, VERIFY_WINDOW);
  if (codeWait !== null) {
    console.warn(`[CONNECT_SIGNUP] rate-limited /verify by number=${mobile.slice(-4)}`);
    res.setHeader('Retry-After', String(codeWait));
    return res.status(429).json({
      success: false, error: 'rate_limited', retryAfter: codeWait,
      message: 'Too many incorrect codes. Please request a new one shortly.',
    });
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
    // Self-serve pays by Stripe card, never Direct Debit — mark the rail at creation so the
    // payment gate and mandate-chasing never treat this customer as a DD account.
    const business = await prisma.business.create({
      data: {
        name: businessName,
        contactName: name,
        contactEmail: email,
        contactPhone: mobile,
        billingMethod: 'stripe_card',
      },
    });

    // 4. Garage — Connect-only: messaging ON, 1-month trial, no voice provisioning.
    const trialEndDate = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
    const garage = await prisma.garage.create({
      data: {
        name: businessName,
        businessId: business.id,
        hasMessagingAccess: true,
        hasVoiceAccess: false,   // Connect-only: no voice tier — portal hides Calls / voice setup
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

    // Seed the two reminder templates every garage needs, as drafts. WhatsApp templates must be
    // approved by Meta before they can be sent, and writing one from scratch is the step new
    // customers stall on — so ship the wording and let them just press Submit. UTILITY category
    // because these are transactional reminders to existing customers, which Meta approves far
    // more readily than MARKETING. Non-fatal: a template failure must not fail the signup.
    void (async () => {
      // Five variables, in this order: 1 customer name, 2 agent name, 3 branch name,
      // 4 registration, 5 due date. Whatever sends the reminder must fill them in that order.
      const templates = [
        {
          name: 'mot_reminder',
          bodyText:
            'Hi {{1}}, it\'s {{2}} from {{3}}. Your car\'s {{4}} MOT is due on {{5}}. Would you like to get that booked in with me? If you\'ve already booked it in, just let me know and I\'ll take you off the reminders.',
          variableSamples: {
            '{{1}}': 'John', '{{2}}': 'Leah', '{{3}}': businessName,
            '{{4}}': 'AB12 CDE', '{{5}}': '15 March',
          },
        },
        {
          // Same shape as the MOT one so both read consistently to the customer.
          name: 'service_reminder',
          bodyText:
            'Hi {{1}}, it\'s {{2}} from {{3}}. Your car\'s {{4}} service is due on {{5}}. Would you like to get that booked in with me? If you\'ve already booked it in, just let me know and I\'ll take you off the reminders.',
          variableSamples: {
            '{{1}}': 'John', '{{2}}': 'Leah', '{{3}}': businessName,
            '{{4}}': 'AB12 CDE', '{{5}}': '15 March',
          },
        },
      ];
      for (const t of templates) {
        try {
          await prisma.messageTemplate.create({
            data: {
              garageId: garage.id,
              name: t.name,
              category: 'UTILITY',
              language: 'en_GB',
              headerType: 'none',
              bodyText: t.bodyText,
              variableSamples: t.variableSamples as any,
              footerText: 'Reply STOP to opt out.',
              buttonType: 'none',
              status: 'draft',
            },
          });
          console.log(`[CONNECT_SIGNUP] seeded template ${t.name} for ${garage.id}`);
        } catch (e: any) {
          // Unique on (garageId, name) — ignore if it somehow already exists.
          console.error(`[CONNECT_SIGNUP] seeding template ${t.name} failed:`, e?.message);
        }
      }
    })();

    // Tell the team. Until now a Connect signup produced NOTHING internally — no SMS, no email,
    // only a HighLevel opportunity nobody was watching, so Kestrels signed up on 2026-08-12 and
    // the first anyone knew was noticing it in the portal by chance. Fire-and-forget so a failed
    // alert can never break a signup that has already succeeded.
    void (async () => {
      const trialEnds = garage.trialEndDate
        ? garage.trialEndDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
        : 'unknown';
      const summary = `New Connect signup: ${businessName} — ${name} (${email}, ${mobile}). Free month ends ${trialEnds}.`;
      try {
        await sendOpsSms(summary);
      } catch (e) {
        console.error('[CONNECT_SIGNUP] ops SMS failed:', e);
      }
      try {
        const to = (process.env.OPS_ALERT_EMAIL_TO || process.env.LEAD_ALERT_EMAIL_TO || '')
          .split(',').map((s) => s.trim()).filter(Boolean);
        if (to.length) {
          await sendEmail({
            to,
            subject: `New Connect signup — ${businessName}`,
            html: `<h2>New Connect free trial</h2>
<table cellpadding="6">
<tr><td><strong>Business</strong></td><td>${businessName}</td></tr>
<tr><td><strong>Contact</strong></td><td>${name}</td></tr>
<tr><td><strong>Email</strong></td><td>${email}</td></tr>
<tr><td><strong>Mobile</strong></td><td>${mobile}</td></tr>
<tr><td><strong>Free month ends</strong></td><td>${trialEnds}</td></tr>
<tr><td><strong>Garage id</strong></td><td>${garage.id}</td></tr>
</table>
<p>No card was taken — this is the card-free Connect trial.</p>`,
            text: summary,
          });
        }
      } catch (e) {
        console.error('[CONNECT_SIGNUP] ops email failed:', e);
      }
    })();

    // Fire-and-forget: create a HighLevel opportunity at the "Free trial live" stage and
    // store its id on the garage. When the trial converts (Stripe webhook), it's promoted
    // to "Live and £££" with the £250 value. Non-fatal — signup succeeds even if HL is down.
    void (async () => {
      try {
        // If the /mot garage picker already created an abandoned-checkout opportunity for this
        // garage, PROMOTE it rather than pushing a second one — otherwise HighLevel ends up with
        // two opportunities for the same business (one stranded at abandoned-checkout forever).
        let opportunityId: string | null = null;
        if (prospectId) {
          const prospect = await prisma.pendingSignup.findUnique({
            where: { id: prospectId },
            select: { id: true, ghlOpportunityId: true },
          });
          if (prospect?.ghlOpportunityId) {
            opportunityId = prospect.ghlOpportunityId;
            console.log(`[CONNECT_SIGNUP] promoting existing HL opportunity ${opportunityId} from prospect ${prospect.id}`);
          }
          // Close the prospect row out either way, so it stops looking like an open lead.
          if (prospect) {
            await prisma.pendingSignup.update({
              where: { id: prospect.id },
              data: { status: 'completed', product: 'connect', email, name, createdGarageId: garage.id },
            }).catch((e) => console.error('[CONNECT_SIGNUP] prospect close failed:', e));
          }
        }
        if (!opportunityId) {
          ({ opportunityId } = await pushSignupToHighlevel({
            name, email, phone: mobile, companyName: businessName,
            source: 'website-mot-connect', tags: ['website-signup', 'connect', 'trial'],
            opportunityName: `${businessName} — Connect trial`,
            monetaryValueGbp: 250, kind: 'signup',
          }));
        }
        if (opportunityId) {
          if (TRIAL_LIVE_STAGE_ID) {
            await updateOpportunity(opportunityId, { stageId: TRIAL_LIVE_STAGE_ID, monetaryValueGbp: 250 }).catch(() => {});
          }
          await prisma.garage.update({ where: { id: garage.id }, data: { ghlOpportunityId: opportunityId } });
        }
      } catch (e) {
        console.error('[CONNECT_SIGNUP] HL opportunity push failed:', e);
      }
    })();

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
