// Service agreement endpoints.
//
// Two flows are supported through the same data model:
//
//  1. SALES-LED — staff fills in commercial terms in the Quick Onboard modal,
//     which creates a draft Agreement + emails the customer a magic-link
//     "sign your agreement" URL. The customer clicks the link, sees the
//     rendered contract, ticks the box, types their name + position, signs.
//
//  2. SELF-SERVE — a customer signs up on the marketing site, the public
//     signup endpoint creates a draft Agreement with Assist defaults
//     (£200/centre/mo, 1 centre, no setup fee), and on first login the
//     portal gates them to /agreement/sign before they can do anything else.
//
// Both flows snapshot the rendered HTML into Agreement.templateSnapshot at
// the moment of signing so future template edits don't change what the
// customer signed.

import type { Request, Response } from 'express';
import { Router } from 'express';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import { prisma } from '../db.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { sendEmail, brandedEmailShell } from '../utils/email.js';
import twilio from 'twilio';
import { normalisePhone } from '../services/outboundSend.js';
import {
  announceGoLiveIfReady,
  sendGarageHiveConnectRequest,
  sendGarageHiveGettingReady,
} from '../services/garageHiveConnect.js';
import { createAssistTrialSubscription, stripeConfigured, STRIPE_TRIAL_DAYS } from '../services/stripe.js';
import {
  renderAgreementHtml,
  TEMPLATE_VERSION,
  AGREEMENT_CSS,
  type LicenceTier,
} from '../services/agreementTemplate.js';
import { renderAgreementPdf } from '../services/agreementPdf.js';
import { renderPartnershipHtml } from '../services/partnershipTemplate.js';
import { renderPartnershipPdf } from '../services/partnershipPdf.js';

const router = Router();

const PORTAL_URL = (process.env.PORTAL_URL || 'https://portal.receptionmate.co.uk').replace(/\/$/, '');
const SIGN_LINK_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const LICENCE_VALUES = ['assist', 'automate', 'connect'] as const;

const draftSchema = z.object({
  userId: z.string().min(1),
  businessId: z.string().min(1).optional(),
  clientName: z.string().min(1).max(200),
  setupFeeGbp: z.number().nonnegative().default(0),
  licenceFeeGbp: z.number().nonnegative(),
  centresCount: z.number().int().positive().default(1),
  licences: z.array(z.enum(LICENCE_VALUES)).min(1).default(['assist']),
  goLiveDate: z.string().datetime().optional().nullable(),
  // The free period before billing starts, from the modal's billing-start choice. Both were
  // being sent and silently dropped, so every agreement rendered a 14-day free trial — even
  // ones sold without one. Null/absent means billing starts at Go Live.
  freeTrialDays: z.number().int().positive().max(365).optional().nullable(),
  freeUntilBookings: z.number().int().positive().max(1000).optional().nullable(),
});

const signSchema = z.object({
  signedByName: z.string().min(1).max(120),
  signedByPosition: z.string().min(1).max(120),
  accepted: z.literal(true), // the clickwrap tick must be true
  // PNG data URL from the signature canvas. Required so the signed copy
  // contains a real signature image, not just a typed name.
  signatureDataUrl: z
    .string()
    .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/, 'Signature must be a PNG data URL')
    .max(500_000), // ~375 KB raw PNG; canvas exports are usually well under this
  signerEmail: z.string().email().max(200).optional(),
});

const markExternalSchema = z.object({
  externalSignatureRef: z.string().min(1).max(200),
  externallySignedAt: z.string().datetime().optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSnapshot(agreement: {
  type?: string;
  clientName: string;
  setupFeeGbp: number;
  licenceFeeGbp: number;
  centresCount: number;
  licences: string[];
  goLiveDate: Date | null;
  freeTrialDays?: number | null;
  freeUntilBookings?: number | null;
}, signed?: { name: string; position: string; at: Date; signatureImage?: string | null }): string {
  if (agreement.type === 'partnership') {
    return renderPartnershipHtml({
      clientName: agreement.clientName,
      effectiveDate: signed?.at ?? null,
      signedByName: signed?.name ?? null,
      signedByPosition: signed?.position ?? null,
      signatureImage: signed?.signatureImage ?? null,
    });
  }
  return renderAgreementHtml({
    clientName: agreement.clientName,
    setupFeeGbp: agreement.setupFeeGbp,
    licenceFeeGbp: agreement.licenceFeeGbp,
    centresCount: agreement.centresCount,
    licences: agreement.licences as LicenceTier[],
    goLiveDate: agreement.goLiveDate,
    freeTrialDays: agreement.freeTrialDays ?? null,
    freeUntilBookings: agreement.freeUntilBookings ?? null,
    effectiveDate: signed?.at ?? null,
    signedByName: signed?.name ?? null,
    signedByPosition: signed?.position ?? null,
    signatureImage: signed?.signatureImage ?? null,
  });
}

function clientIp(req: Request): string {
  const forwarded = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim();
  return forwarded || req.ip || '';
}

async function issueSignLinkToken(userId: string, agreementId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await prisma.signLinkToken.create({
    data: {
      token,
      userId,
      agreementId,
      purpose: 'sign_agreement',
      expiresAt: new Date(Date.now() + SIGN_LINK_TTL_MS),
    },
  });
  return token;
}

// ---------------------------------------------------------------------------
// PUBLIC: customer-facing endpoints
// ---------------------------------------------------------------------------

/**
 * GET /api/agreements/me/pending
 * Returns the authenticated user's unsigned agreement (draft or sent), if any.
 */
router.get('/agreements/me/pending', authenticate, async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorised' });

  const agreement = await prisma.agreement.findFirst({
    where: {
      userId: req.user.userId,
      status: { in: ['draft', 'sent'] },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (!agreement) {
    return res.json({ agreement: null });
  }

  const html = buildSnapshot(agreement);
  return res.json({
    agreement: {
      id: agreement.id,
      clientName: agreement.clientName,
      setupFeeGbp: agreement.setupFeeGbp,
      licenceFeeGbp: agreement.licenceFeeGbp,
      centresCount: agreement.centresCount,
      licences: agreement.licences,
      goLiveDate: agreement.goLiveDate,
      status: agreement.status,
      type: agreement.type,
      version: agreement.version,
    },
    html,
    css: AGREEMENT_CSS,
  });
});

/**
 * GET /api/agreements/sign/:token
 * Exchange a magic-link token for the agreement contents (no login required).
 * Does NOT consume the token — that happens at POST sign.
 */
router.get('/agreements/sign/:token', async (req: Request, res: Response) => {
  const tokenRow = await prisma.signLinkToken.findUnique({
    where: { token: req.params.token },
    include: { user: true },
  });

  if (!tokenRow || tokenRow.consumedAt || tokenRow.expiresAt < new Date() || !tokenRow.agreementId) {
    // Not a manual/legacy sign token — try a self-serve PendingSignup (deferred-account flow).
    return renderPendingSignAgreement(req.params.token, res);
  }

  const agreement = await prisma.agreement.findUnique({ where: { id: tokenRow.agreementId } });
  if (!agreement) {
    return res.status(404).json({ error: 'Agreement not found' });
  }
  if (agreement.status === 'signed' || agreement.status === 'externally_signed') {
    return res.status(409).json({ error: 'Agreement is already signed' });
  }

  const html = buildSnapshot(agreement);
  return res.json({
    agreement: {
      id: agreement.id,
      clientName: agreement.clientName,
      setupFeeGbp: agreement.setupFeeGbp,
      licenceFeeGbp: agreement.licenceFeeGbp,
      centresCount: agreement.centresCount,
      licences: agreement.licences,
      goLiveDate: agreement.goLiveDate,
      status: agreement.status,
      type: agreement.type,
      version: agreement.version,
    },
    customerEmail: tokenRow.user.email,
    html,
    css: AGREEMENT_CSS,
  });
});

/**
 * POST /api/agreements/sign/:token
 * Sign via magic link (no portal login).
 */
router.post('/agreements/sign/:token', async (req: Request, res: Response) => {
  const parsed = signSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
  }

  const tokenRow = await prisma.signLinkToken.findUnique({ where: { token: req.params.token } });
  if (!tokenRow || tokenRow.consumedAt || tokenRow.expiresAt < new Date() || !tokenRow.agreementId) {
    // Not a manual/legacy sign token — try a self-serve PendingSignup (deferred-account flow).
    return finalisePendingSignature(req.params.token, parsed.data, clientIp(req), req.headers['user-agent'] ?? '', res);
  }

  return finaliseSignature({
    agreementId: tokenRow.agreementId,
    userId: tokenRow.userId,
    signedByName: parsed.data.signedByName,
    signedByPosition: parsed.data.signedByPosition,
    signatureImage: parsed.data.signatureDataUrl,
    ip: clientIp(req),
    userAgent: req.headers['user-agent'] ?? '',
    consumeTokenId: tokenRow.id,
    signerEmail: parsed.data.signerEmail,
    res,
  });
});

/**
 * POST /api/agreements/:id/sign
 * Sign while authenticated in the portal.
 */
router.post('/agreements/:id/sign', authenticate, async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorised' });

  const parsed = signSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
  }

  const agreement = await prisma.agreement.findUnique({ where: { id: req.params.id } });
  if (!agreement) return res.status(404).json({ error: 'Agreement not found' });

  // Allow staff to sign on behalf only via the admin endpoint — not here.
  if (agreement.userId !== req.user.userId) {
    return res.status(403).json({ error: 'Not your agreement to sign' });
  }

  return finaliseSignature({
    agreementId: agreement.id,
    userId: agreement.userId,
    signedByName: parsed.data.signedByName,
    signedByPosition: parsed.data.signedByPosition,
    signatureImage: parsed.data.signatureDataUrl,
    ip: clientIp(req),
    userAgent: req.headers['user-agent'] ?? '',
    signerEmail: parsed.data.signerEmail,
    res,
  });
});

async function finaliseSignature(opts: {
  agreementId: string;
  userId: string;
  signedByName: string;
  signedByPosition: string;
  signatureImage: string;
  ip: string;
  userAgent: string;
  consumeTokenId?: string;
  signerEmail?: string;
  res: Response;
}) {
  const agreement = await prisma.agreement.findUnique({ where: { id: opts.agreementId } });
  if (!agreement) return opts.res.status(404).json({ error: 'Agreement not found' });
  if (agreement.status === 'signed' || agreement.status === 'externally_signed') {
    return opts.res.status(409).json({ error: 'Already signed' });
  }
  if (agreement.status === 'voided') {
    return opts.res.status(409).json({ error: 'Agreement is voided' });
  }

  const user = await prisma.user.findUnique({ where: { id: opts.userId } });
  const now = new Date();
  const snapshot = buildSnapshot(agreement, {
    name: opts.signedByName,
    position: opts.signedByPosition,
    at: now,
    signatureImage: opts.signatureImage,
  });

  const [updated] = await prisma.$transaction([
    prisma.agreement.update({
      where: { id: agreement.id },
      data: {
        status: 'signed',
        signedAt: now,
        signedByName: opts.signedByName,
        signedByPosition: opts.signedByPosition,
        signedByEmail: opts.signerEmail || user?.email || null,
        signedFromIp: opts.ip,
        signedUserAgent: opts.userAgent.slice(0, 500),
        signatureImage: opts.signatureImage,
        templateSnapshot: snapshot,
      },
    }),
    prisma.user.update({
      where: { id: opts.userId },
      data: { mustSignAgreement: false },
    }),
    ...(opts.consumeTokenId
      ? [prisma.signLinkToken.update({ where: { id: opts.consumeTokenId }, data: { consumedAt: now } })]
      : []),
  ]);

  // Fire-and-forget copies to both parties so a slow PDF render + email send
  // doesn't delay the success response to the customer.
  void sendSignedCopies({
    agreement,
    snapshot,
    signedByName: opts.signedByName,
    signedByPosition: opts.signedByPosition,
    signatureImage: opts.signatureImage,
    signedAt: now,
    signerEmail: opts.signerEmail || user?.email || null,
    clientName: agreement.clientName,
  });

  // Signing is the trigger for the GarageHive onboarding pair, and both had stopped: the
  // service they live in was lost with the rest of the connect flow, so nothing has called
  // either since August. Ask GarageHive for the instance, and tell the garage what to set up
  // while we build their agent. Fire-and-forget, and both are internally no-ops for a business
  // that isn't on GarageHive, so this is safe for every other agreement.
  void (async () => {
    try {
      if (agreement.businessId) await sendGarageHiveConnectRequest(agreement.businessId);
      const garages = agreement.businessId
        ? await prisma.garage.findMany({
            where: { businessId: agreement.businessId },
            select: { id: true },
          })
        : [];
      for (const g of garages) {
        await sendGarageHiveGettingReady(g.id);
        // Go-live needs BOTH tracks done, and either can finish last. It was only ever checked
        // when the diary connected, so a garage whose diary was already wired and who signed
        // afterwards would never have gone live — signing is the last piece there, and nothing
        // re-asked. Checking from both sides is what makes it converge.
        await announceGoLiveIfReady(g.id);
      }
    } catch (err) {
      console.error('[AGREEMENT] GarageHive onboarding emails failed:', err);
    }
  })();

  // Public-signup customers (mustChangePassword === true) start their 14-day free trial with a
  // custom Stripe Payment Element (no redirect). We create a trial subscription now and return its
  // SetupIntent client_secret; the sign page mounts the card form and confirms it. Provisioning +
  // welcome email fire from the Stripe webhook (setup_intent.succeeded) once the card is confirmed.
  let checkoutClientSecret: string | null = null;

  // Who gets asked for a card at signing?
  //
  // This used to start from `!!user?.mustChangePassword`, treating that as "a self-serve
  // signup". It is not. Quick onboard sets mustChangePassword on every user it creates, so a
  // customer sold on Direct Debit was taken to a Stripe card step the moment they signed —
  // and 34 of the businesses on the estate bill by Direct Debit.
  //
  // How the deal is billed is the actual answer, so ask that first: never request a card when
  // the customer is paying by Direct Debit or on invoice, whatever their password state.
  let wantsTrialCard = false;
  if (user && stripeConfigured()) {
    const gid = user.garageAccessIds?.[0] ?? null;
    const g = gid
      ? await prisma.garage.findUnique({
          where: { id: gid },
          select: {
            stripeSubscriptionId: true, trialEndsAt: true, trialEndDate: true,
            business: { select: { billingMethod: true } },
          },
        })
      : null;
    const billingMethod = g?.business?.billingMethod ?? null;
    // Null covers self-serve signups, whose billing method is not set until later.
    const cardBilled = billingMethod !== 'directdebit' && billingMethod !== 'invoice';
    if (cardBilled) {
      const trialEnd = g?.trialEndsAt ?? g?.trialEndDate ?? null;
      wantsTrialCard =
        // Self-serve signups: they choose a password after signing, so this still identifies them.
        !!user.mustChangePassword
        // Or a hand-made trial plainly set up for a card: on a trial, billing by Stripe, and no
        // subscription yet. Without this a manually-created card trial had no way to take one.
        || (!!g
          && !g.stripeSubscriptionId
          && billingMethod === 'stripe_card'
          && !!trialEnd && trialEnd > new Date());
    }
  }

  if (wantsTrialCard && stripeConfigured()) {
    try {
      const garageId = user!.garageAccessIds?.[0] ?? null;
      if (garageId) {
        const trial = await createAssistTrialSubscription({
          userId: user!.id,
          email: user!.email,
          businessName: agreement.clientName,
          garageId,
          agreementId: agreement.id,
        });
        checkoutClientSecret = trial.clientSecret;
        // Store the Stripe refs now so the setup_intent.succeeded webhook can map the confirmed
        // card back to this garage (by customer id) and provision the account.
        const trialEndsAt = new Date(Date.now() + STRIPE_TRIAL_DAYS * 24 * 60 * 60 * 1000);
        await prisma.garage.update({
          where: { id: garageId },
          data: {
            stripeCustomerId: trial.customerId,
            stripeSubscriptionId: trial.subscriptionId,
            trialEndsAt,
          },
        });
      } else {
        console.warn('[AGREEMENT_SIGN] public-signup user has no garage — skipping Stripe trial');
      }
    } catch (e) {
      console.error('[AGREEMENT_SIGN] Stripe trial subscription create failed:', e);
    }
  }

  // Self-serve customers set their own password straight after the card (no reliance on the
  // welcome email that hotmail/Outlook loves to eat), then log in. Mint a one-time password-setup
  // token now and clear the Direct-Debit gate (they pay by Stripe card, not DD). Once the card is
  // confirmed the sign page sends them to /reset-password?token=… . Manually-onboarded customers
  // never hit this path, so they keep the welcome-email flow untouched.
  let passwordSetupToken: string | null = null;
  if (opts.consumeTokenId && checkoutClientSecret && user) {
    const resetToken = randomBytes(32).toString('hex');
    await prisma.user.update({
      where: { id: user.id },
      data: {
        resetToken,
        resetTokenExpiry: new Date(Date.now() + 60 * 60 * 1000),
        mustSetupPayment: false, // paid via Stripe card — skip the GoCardless DD gate
      },
    });
    passwordSetupToken = resetToken;
  }

  // After signing: tell the frontend what the next gate is so it can route
  // straight into DD setup or the dashboard without bouncing through /login.
  const nextStep: 'payment' | 'dashboard' = user?.mustSetupPayment ? 'payment' : 'dashboard';

  return opts.res.json({
    success: true,
    nextStep,
    // When set, the marketing-flow customer should enter their card (Stripe Payment Element)
    // to start the trial — the sign page mounts the form with this SetupIntent client_secret.
    checkoutClientSecret,
    // After the card is confirmed, the self-serve customer is sent to /reset-password?token=this
    // to set their own password, then logs in — no welcome email needed to get into the portal.
    passwordSetupToken,
    agreement: {
      id: updated.id,
      status: updated.status,
      signedAt: updated.signedAt,
      signedByName: updated.signedByName,
    },
  });
}

// ── Self-serve deferred-account flow: the sign token maps to a PendingSignup, not an Agreement.
// No account exists yet; we render/sign against the pending row and create the Stripe trial. The
// real account is created only after the card is confirmed (POST /public/signup-complete + webhook).
function pendingAgreementInputs(businessName: string) {
  return {
    type: 'saas',
    clientName: businessName,
    setupFeeGbp: 0,
    licenceFeeGbp: 200,
    centresCount: 1,
    licences: ['assist'] as string[],
    goLiveDate: null as Date | null,
  };
}

async function renderPendingSignAgreement(token: string, res: Response) {
  const pending = await prisma.pendingSignup.findUnique({ where: { signToken: token } });
  if (!pending || pending.status === 'completed' || pending.expiresAt < new Date()) {
    return res.status(404).json({ error: 'Sign link not found or expired' });
  }
  const html = buildSnapshot(pendingAgreementInputs(pending.businessName));
  return res.json({
    agreement: {
      id: 'pending', clientName: pending.businessName, setupFeeGbp: 0, licenceFeeGbp: 200,
      centresCount: 1, licences: ['assist'], goLiveDate: null, status: 'sent', type: 'saas', version: TEMPLATE_VERSION,
    },
    customerEmail: pending.email,
    html,
    css: AGREEMENT_CSS,
  });
}

async function finalisePendingSignature(
  token: string,
  data: { signedByName: string; signedByPosition: string; signatureDataUrl: string; signerEmail?: string },
  ip: string,
  userAgent: string,
  res: Response,
) {
  const pending = await prisma.pendingSignup.findUnique({ where: { signToken: token } });
  if (!pending || pending.expiresAt < new Date()) {
    return res.status(404).json({ error: 'Sign link not found or expired' });
  }
  if (pending.createdGarageId) return res.status(409).json({ error: 'Already completed' });

  // Check before anything is created in Stripe.
  if (looksLikeKeyboardMash(data.signedByName) || looksLikeKeyboardMash(data.signedByPosition)) {
    console.warn(`[AGREEMENT_SIGN] rejected junk signature for "${pending.businessName}": name="${data.signedByName}" position="${data.signedByPosition}"`);
    return res.status(400).json({
      error: 'Please enter your full name and your position at the business as they should appear on the agreement.',
    });
  }

  const now = new Date();
  const snapshot = buildSnapshot(pendingAgreementInputs(pending.businessName), {
    name: data.signedByName, position: data.signedByPosition, at: now, signatureImage: data.signatureDataUrl,
  });

  // Create the Stripe 14-day trial keyed to this pending signup (metadata carries pendingSignupId).
  let checkoutClientSecret: string | null = null;
  let stripeCustomerId: string | null = null;
  let stripeSubscriptionId: string | null = null;
  if (stripeConfigured()) {
    try {
      const trial = await createAssistTrialSubscription({
        email: pending.email, businessName: pending.businessName, pendingSignupId: pending.id,
      });
      checkoutClientSecret = trial.clientSecret;
      stripeCustomerId = trial.customerId;
      stripeSubscriptionId = trial.subscriptionId;
    } catch (e) {
      console.error('[AGREEMENT_SIGN] pending Stripe trial create failed:', e);
    }
  }
  const trialEndsAt = new Date(Date.now() + STRIPE_TRIAL_DAYS * 24 * 60 * 60 * 1000);
  await prisma.pendingSignup.update({
    where: { id: pending.id },
    data: {
      status: 'signed',
      signedByName: data.signedByName,
      signedByPosition: data.signedByPosition,
      signatureImage: data.signatureDataUrl,
      signedFromIp: ip,
      signedUserAgent: userAgent.slice(0, 500),
      signedAt: now,
      templateSnapshot: snapshot,
      agreementVersion: TEMPLATE_VERSION,
      email: data.signerEmail ? data.signerEmail.toLowerCase() : pending.email,
      stripeCustomerId,
      stripeSubscriptionId,
      trialEndsAt,
    },
  });

  return res.json({
    success: true,
    nextStep: 'payment',
    checkoutClientSecret,
    passwordSetupToken: null, // account isn't created until the card confirms — set then, via /public/signup-complete
    pendingSignupId: pending.id,
    agreement: { id: 'pending', status: 'signed', signedAt: now, signedByName: data.signedByName },
  });
}


/**
 * Does this look like somebody actually signing, or somebody mashing the keyboard?
 *
 * A signature creates a real Stripe customer and a real trialing subscription before anyone has
 * proved they exist. On 2026-08-19 "Princes End Garage" was signed by "qweq", position "qwe",
 * email dd@mail.com — no account, no card, no money, but a live subscription in Stripe that will
 * fail on 2026-09-02. Deferring the Stripe call to the card step does not help, because that form
 * renders on the same page a second later. The only place to stop it is here.
 *
 * Deliberately conservative: it looks for keyboard runs and repeated characters, not for names
 * that merely seem unusual. Rejecting a real customer's signature is far worse than letting a
 * junk subscription through, and people's names are not ours to judge.
 */
const KEYBOARD_RUNS = ['qwe', 'wer', 'ert', 'rty', 'tyu', 'asd', 'sdf', 'dfg', 'fgh', 'zxc', 'xcv', 'cvb', '123456'];

function looksLikeKeyboardMash(value: string): boolean {
  const v = (value || '').trim().toLowerCase();
  if (v.length < 2) return true;                             // "a" is not a name
  if (/^(.)\1+$/.test(v)) return true;                       // "aaa", "zzzz"
  const letters = v.replace(/[^a-z]/g, '');
  if (!letters) return true;                                  // digits or symbols only
  return KEYBOARD_RUNS.some((run) => letters.includes(run));
}

const SIGNED_COPY_BCC = 'hello@receptionmate.co.uk';

async function sendSignedCopies(args: {
  agreement: {
    type?: string;
    clientName: string;
    setupFeeGbp: number;
    licenceFeeGbp: number;
    centresCount: number;
    licences: string[];
    goLiveDate: Date | null;
  };
  snapshot: string;
  signedByName: string;
  signedByPosition: string;
  signatureImage: string;
  signedAt: Date;
  signerEmail: string | null;
  clientName: string;
}) {
  const subject = `Signed: ReceptionMate service agreement — ${args.clientName}`;
  const intro = `
    <div style="font-family:Inter,system-ui,sans-serif;max-width:680px;margin:0 auto;color:#0f172a;padding:24px 0;">
      <h2 style="color:#3426cf;margin:0 0 12px;">Thanks ${escapeForEmail(args.signedByName)} — your agreement is signed</h2>
      <p>A copy of your fully-signed ReceptionMate service agreement is <strong>attached</strong> for your records.</p>
      <p style="color:#475569;font-size:14px;">If you have any questions, just reply to this email.</p>
    </div>
  `;
  const text = `Your ReceptionMate service agreement is signed. A copy is attached for your records.`;

  const targets: string[] = [];
  if (args.signerEmail) targets.push(args.signerEmail);
  targets.push(SIGNED_COPY_BCC);

  try {
    let attachment: { filename: string; content: Buffer; contentType: string };
    if (args.agreement.type === 'partnership') {
      const pdfBuffer = await renderPartnershipPdf({
        clientName: args.agreement.clientName,
        effectiveDate: args.signedAt,
        signedByName: args.signedByName,
        signedByPosition: args.signedByPosition,
        signatureImage: args.signatureImage,
      });
      attachment = {
        filename: `ReceptionMate-Agreement-${slugify(args.clientName)}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf',
      };
    } else {
      const pdfBuffer = await renderAgreementPdf({
        clientName: args.agreement.clientName,
        setupFeeGbp: args.agreement.setupFeeGbp,
        licenceFeeGbp: args.agreement.licenceFeeGbp,
        centresCount: args.agreement.centresCount,
        licences: args.agreement.licences as LicenceTier[],
        goLiveDate: args.agreement.goLiveDate,
        effectiveDate: args.signedAt,
        signedByName: args.signedByName,
        signedByPosition: args.signedByPosition,
        signatureImage: args.signatureImage,
      });
      attachment = {
        filename: `ReceptionMate-Agreement-${slugify(args.clientName)}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf',
      };
    }

    await sendEmail({
      to: targets,
      subject,
      html: intro,
      text,
      attachments: [attachment],
    });
  } catch (err) {
    console.error('[AGREEMENT] failed to send signed copies:', err);
  }
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60) || 'agreement';
}

// ---------------------------------------------------------------------------
// ADMIN: staff-only endpoints
// ---------------------------------------------------------------------------

/**
 * POST /api/admin/agreements/draft
 * Staff creates a draft agreement with commercial terms.
 */
router.post('/admin/agreements/draft', authenticate, requireAdmin, async (req: Request, res: Response) => {
  const parsed = draftSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
  }

  const user = await prisma.user.findUnique({ where: { id: parsed.data.userId } });
  if (!user) return res.status(404).json({ error: 'User not found' });

  const goLiveDate = parsed.data.goLiveDate ? new Date(parsed.data.goLiveDate) : null;

  const agreement = await prisma.agreement.create({
    data: {
      type: 'saas',
      version: TEMPLATE_VERSION,
      status: 'draft',
      userId: parsed.data.userId,
      businessId: parsed.data.businessId,
      clientName: parsed.data.clientName,
      setupFeeGbp: parsed.data.setupFeeGbp,
      licenceFeeGbp: parsed.data.licenceFeeGbp,
      centresCount: parsed.data.centresCount,
      licences: parsed.data.licences,
      goLiveDate,
      freeTrialDays: parsed.data.freeTrialDays ?? null,
      freeUntilBookings: parsed.data.freeUntilBookings ?? null,
      templateSnapshot: '', // populated on send/sign
      issuedByUserId: req.user!.userId,
    },
  });

  return res.status(201).json({ agreement });
});

/**
 * POST /api/admin/agreements/:id/send
 * Send the magic-link sign email to the customer.
 */
const sendAgreementSchema = z.object({
  // The director signs; the manager uses the system. Both optional — empty means "as normal".
  toEmail: z.string().email().max(200).optional(),
  toSms: z.string().min(6).max(30).optional(),
});

router.post('/admin/agreements/:id/send', authenticate, requireAdmin, async (req: Request, res: Response) => {
  // The Quick Onboard modal and the Agreements Send dialog have always posted { toEmail, toSms }.
  // Nothing here read them, and zod strips unknown keys, so the override was silently ignored
  // and the SMS was never sent at all.
  const opts = sendAgreementSchema.safeParse(req.body ?? {});
  if (!opts.success) {
    return res.status(400).json({ error: 'toEmail must be an email and toSms a phone number.' });
  }
  const agreement = await prisma.agreement.findUnique({
    where: { id: req.params.id },
    include: { user: true },
  });
  if (!agreement) return res.status(404).json({ error: 'Agreement not found' });
  if (agreement.status === 'signed' || agreement.status === 'externally_signed') {
    return res.status(409).json({ error: 'Already signed' });
  }

  const token = await issueSignLinkToken(agreement.userId, agreement.id);
  const signUrl = `${PORTAL_URL}/agreement/sign?token=${encodeURIComponent(token)}`;
  const toEmail = opts.data.toEmail || agreement.user.email;

  const subject = 'Your ReceptionMate service agreement is ready to sign';
  const body =
    `<tr><td style="padding: 32px;">` +
    `<h1 style="margin:0 0 14px;font-size:20px;color:#0f172a;font-weight:700;">Hi ${escapeForEmail(agreement.clientName)},</h1>` +
    `<p style="margin:0 0 20px;font-size:15px;line-height:1.55;color:#475569;">Your ReceptionMate service agreement is ready. Have a read through and sign below — it should only take a minute.</p>` +
    `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 auto 18px;"><tr>` +
    `<td style="background:#3426cf;border-radius:10px;"><a href="${signUrl}" style="display:inline-block;padding:14px 30px;color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;">Review and sign</a></td>` +
    `</tr></table>` +
    `<p style="margin:0;font-size:14px;line-height:1.55;color:#475569;">This link is valid for 14 days. If you have any questions, just reply to this email.</p>` +
    `</td></tr>`;
  const text = `Your ReceptionMate service agreement is ready to sign.\n\nReview and sign here: ${signUrl}\n\nThis link is valid for 14 days.\n\n— The ReceptionMate team`;

  const sent = await sendEmail({ to: [toEmail], subject, html: brandedEmailShell(body), text });
  if (!sent) {
    return res.status(500).json({ error: 'Failed to send email' });
  }

  // Text the link too when asked. Reported back rather than thrown: the email is the thing that
  // matters, and the modal shows smsError to whoever pressed the button.
  let smsError: string | null = null;
  if (opts.data.toSms) {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const tok = process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !tok) {
      smsError = 'Agreement emailed, but SMS is not configured on this server.';
    } else {
      // Twilio needs E.164 and rejects a UK number typed the way anyone actually types one —
      // "07976500282" comes back as Invalid 'To' Phone Number. Reuse the normaliser the
      // outbound sender already uses rather than a second opinion on what a phone number is.
      const toSms = normalisePhone(opts.data.toSms);
      try {
        await twilio(sid, tok).messages.create({
          to: toSms,
          from: process.env.TWILIO_SMS_FROM || 'ReceptMate',
          body: `Your ReceptionMate service agreement is ready to sign: ${signUrl} (valid 14 days)`,
        });
      } catch (err) {
        smsError = `Agreement emailed, but the text to ${toSms} failed: ${
          err instanceof Error ? err.message : 'unknown error'
        }`;
        console.error('[AGREEMENT] sign-link SMS failed:', err);
      }
    }
  }

  await prisma.agreement.update({
    where: { id: agreement.id },
    data: { status: 'sent', sentAt: new Date(), sentToEmail: toEmail },
  });

  return res.json({ success: true, signUrl, sentTo: toEmail, smsError });
});

/**
 * GET /api/admin/agreements/:id/pdf
 * Download a signed agreement. The PDF was only ever emailed at the moment of signing, so a copy
 * that got lost or went to the wrong address could not be retrieved from the portal at all.
 */
router.get('/admin/agreements/:id/pdf', authenticate, requireAdmin, async (req: Request, res: Response) => {
  const agreement = await prisma.agreement.findUnique({ where: { id: req.params.id } });
  if (!agreement) return res.status(404).json({ error: 'Agreement not found' });
  if (agreement.status !== 'signed' && agreement.status !== 'externally_signed') {
    return res.status(409).json({ error: 'This agreement has not been signed yet.' });
  }
  try {
    const pdf = await renderAgreementPdf({
      clientName: agreement.clientName,
      setupFeeGbp: agreement.setupFeeGbp,
      licenceFeeGbp: agreement.licenceFeeGbp,
      centresCount: agreement.centresCount,
      licences: agreement.licences as LicenceTier[],
      goLiveDate: agreement.goLiveDate,
      effectiveDate: agreement.signedAt ?? agreement.externallySignedAt,
      signedByName: agreement.signedByName ?? '',
      // Blank for anything signed before this column existed — the position is in that
      // agreement's templateSnapshot, which is the legal record either way.
      signedByPosition: agreement.signedByPosition ?? '',
      signatureImage: agreement.signatureImage,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="ReceptionMate-Agreement-${slugify(agreement.clientName)}.pdf"`,
    );
    return res.send(pdf);
  } catch (err) {
    console.error('[AGREEMENT] PDF render failed:', err);
    return res.status(500).json({ error: 'Could not render the PDF.' });
  }
});

/**
 * POST /api/admin/agreements/:id/mark-external
 * Mark an agreement as already signed elsewhere (e.g. High Level legacy).
 * Clears the user's mustSignAgreement gate.
 */
router.post('/admin/agreements/:id/mark-external', authenticate, requireAdmin, async (req: Request, res: Response) => {
  const parsed = markExternalSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
  }

  const agreement = await prisma.agreement.findUnique({ where: { id: req.params.id } });
  if (!agreement) return res.status(404).json({ error: 'Agreement not found' });

  const externallySignedAt = parsed.data.externallySignedAt
    ? new Date(parsed.data.externallySignedAt)
    : new Date();

  await prisma.$transaction([
    prisma.agreement.update({
      where: { id: agreement.id },
      data: {
        status: 'externally_signed',
        externallySignedAt,
        externalSignatureRef: parsed.data.externalSignatureRef,
        templateSnapshot: buildSnapshot(agreement),
      },
    }),
    prisma.user.update({
      where: { id: agreement.userId },
      data: { mustSignAgreement: false },
    }),
  ]);

  return res.json({ success: true });
});

/**
 * GET /api/admin/agreements
 * List agreements for staff dashboard.
 */
router.get('/admin/agreements', authenticate, requireAdmin, async (req: Request, res: Response) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const agreements = await prisma.agreement.findMany({
    where: status ? { status } : undefined,
    orderBy: { createdAt: 'desc' },
    include: { user: { select: { email: true } } },
    take: 200,
  });
  return res.json({ agreements });
});

function escapeForEmail(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export default router;
