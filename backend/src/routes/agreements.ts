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
import { setOnboardingStage } from '../utils/onboardingStage.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { sendEmail, sendAgreementSignEmail } from '../utils/email.js';
import { signConnectToken, businessUsesGarageHive } from '../services/garageHiveConnect.js';
import { sendCustomerSms, toE164UK } from '../utils/sms.js';
import { createSetupFeeInvoice, emailSetupFeeInvoice } from '../services/setupFeeInvoice.js';
import { createAssistTrialSubscription, stripeConfigured, STRIPE_TRIAL_DAYS, getStripeClient } from '../services/stripe.js';
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
  // The Connect per-branch fee, when the deal has one. Separate from licenceFeeGbp (voice)
  // because billing raises them as two lines per branch — a contract quoting one blended figure
  // can't be reconciled against the invoice.
  messagingFeeGbp: z.number().nonnegative().default(0),
  // The free period actually sold. Omit both for "billing starts at payment setup" — the
  // contract then says nothing about a trial rather than promising a hardcoded 14 days.
  freeTrialDays: z.number().int().positive().max(365).optional().nullable(),
  freeUntilBookings: z.number().int().positive().max(1000).optional().nullable(),
  centresCount: z.number().int().positive().default(1),
  licences: z.array(z.enum(LICENCE_VALUES)).min(1).default(['assist']),
  goLiveDate: z.string().datetime().optional().nullable(),
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
  messagingFeeGbp?: number;
  freeTrialDays?: number | null;
  freeUntilBookings?: number | null;
  centresCount: number;
  licences: string[];
  goLiveDate: Date | null;
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
    messagingFeeGbp: agreement.messagingFeeGbp,
    freeTrialDays: agreement.freeTrialDays,
    freeUntilBookings: agreement.freeUntilBookings,
    centresCount: agreement.centresCount,
    licences: agreement.licences as LicenceTier[],
    goLiveDate: agreement.goLiveDate,
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
  // Audit: they've opened it. Fire-and-forget — never let a tracking write stop someone reading
  // their own contract. Keeps first + last + a count, so "opened 3 times over two days" is
  // answerable, and the IP/UA of the FIRST open (the one that matters evidentially).
  void (async () => {
    try {
      const tok = await prisma.signLinkToken.findUnique({
        where: { token: req.params.token },
        select: { agreementId: true },
      });
      if (!tok?.agreementId) return;
      const now = new Date();
      const existing = await prisma.agreement.findUnique({
        where: { id: tok.agreementId },
        select: { firstViewedAt: true },
      });
      await prisma.agreement.update({
        where: { id: tok.agreementId },
        data: {
          lastViewedAt: now,
          viewCount: { increment: 1 },
          ...(existing?.firstViewedAt
            ? {}
            : { firstViewedAt: now, viewedFromIp: clientIp(req), viewedUserAgent: req.headers['user-agent'] ?? null }),
        },
      });
    } catch (err) {
      console.error('[AGREEMENT] view tracking failed (non-fatal):', err);
    }
  })();

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

  // Signed => the deal moves on: we now chase the garage's GarageHive/Tyresoft credentials and
  // build the agent. Resolve the garage from the agreement's business (the agreement is the
  // business-level contract); fall back to the signer's first garage for older rows without one.
  void (async () => {
    // The agreement is a BUSINESS-level contract (hence centresCount), so move every branch of
    // that business that's still in the pipeline. setOnboardingStage skips anything already
    // 'live', so this can't disturb existing branches of an expanding customer.
    const garageIds = agreement.businessId
      ? (await prisma.garage.findMany({ where: { businessId: agreement.businessId }, select: { id: true } })).map((g) => g.id)
      : [];
    // Fall back to the signer's own garage for older agreements with no businessId.
    if (!garageIds.length && user?.garageAccessIds?.[0]) garageIds.push(user.garageAccessIds[0]);
    // Deal value is the whole contract; it belongs on the opportunity once, not once per branch.
    const dealValue = (agreement.licenceFeeGbp ?? 0) * (agreement.centresCount ?? 1);
    for (const garageId of garageIds) {
      await setOnboardingStage(garageId, 'awaiting_credentials', {
        monetaryValueGbp: dealValue,
        reason: 'agreement signed',
      });
    }
  })();

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

  // NO Stripe here. This function is only ever reached by a STAFF-ISSUED agreement — the sign
  // token is minted solely by POST /admin/agreements/:id/send — and staff-issued means a Direct
  // Debit customer. Self-serve runs a different function entirely (finalisePendingSignature),
  // which creates its own trial keyed on pendingSignupId. Only self-serve pays by Stripe card.
  //
  // This used to create a Stripe Assist trial + clear the DD gate for anyone with
  // mustChangePassword === true, on the stated premise that "manually-onboarded customers never
  // hit this path". That was false: /admin/onboard sets mustChangePassword: true. So a staff
  // onboarded DD customer signing their agreement got (a) a 14-day trial at STRIPE_ASSIST_PRICE_ID
  // regardless of what licenceFeeGbp they actually agreed, (b) a card form on the sign page, and
  // (c) mustSetupPayment: false — silently deleting the Direct Debit step from their onboarding.
  // Never triggered: every agreement to date was licences:["assist"], and the only Stripe-subbed
  // garages are a genuine self-serve signup and an internal test. Moto Oil was one click away.
  //
  // Kept in the response as nulls: finalisePendingSignature returns the same shape and the sign
  // page reads both fields, so the contract must not change. A manually-onboarded customer who
  // should pay by card is handled by the payment gate (/setup-payment), at their agreed price —
  // not by a hardcoded Assist trial that skips the gate.
  const checkoutClientSecret: string | null = null;
  const passwordSetupToken: string | null = null;

  // A setup fee is "due upon signing" per the agreement text, so raise its invoice now and hand
  // the card link straight back — the customer gets a pay page instead of being told to watch
  // their inbox. Awaited (not fire-and-forget) because the sign page needs payUrl in THIS
  // response; it's one insert plus one Stripe call. The PDF render + email are fired separately
  // so they can't slow signing down.
  //
  // Never fires for self-serve: those hardcode setupFeeGbp: 0, and createSetupFeeInvoice returns
  // null at 0. Wrapped in try/catch because a billing hiccup must not fail a signature — the
  // contract is signed either way and the fee can be chased.
  let setupFee: { invoiceNumber: string; grossPence: number; payUrl: string | null } | null = null;
  try {
    const fee = await createSetupFeeInvoice(agreement.id);
    if (fee) {
      setupFee = { invoiceNumber: fee.invoiceNumber, grossPence: fee.grossPence, payUrl: fee.payUrl };
      void emailSetupFeeInvoice(fee);
    }
  } catch (err) {
    console.error(`[SETUP-FEE] raising the invoice for agreement ${agreement.id} failed:`, err);
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
    // Present only when the agreement carried a setup fee: the sign page turns this into a
    // "pay your setup fee" step with a card button and our bank details.
    setupFee,
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

const SIGNED_COPY_BCC = 'hello@receptionmate.co.uk';

async function sendSignedCopies(args: {
  agreement: {
    type?: string;
    clientName: string;
    setupFeeGbp: number;
    licenceFeeGbp: number;
    messagingFeeGbp: number;
    freeTrialDays?: number | null;
    freeUntilBookings?: number | null;
    centresCount: number;
    licences: string[];
    goLiveDate: Date | null;
    // Audit trail for the PDF's final page. Optional so the partnership path and any older
    // caller still type-check; missing values print "Not recorded" rather than being hidden.
    id?: string;
    version?: string;
    sentToEmail?: string | null;
    sentToSms?: string | null;
    sentAt?: Date | null;
    firstViewedAt?: Date | null;
    lastViewedAt?: Date | null;
    viewCount?: number | null;
    viewedFromIp?: string | null;
    viewedUserAgent?: string | null;
    signedFromIp?: string | null;
    signedUserAgent?: string | null;
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
        // The exact HTML they signed. The PDF renders THIS rather than its own copy of the
        // clauses — which is how the two came to state different contract terms.
        bodyHtml: args.snapshot,
        clientName: args.agreement.clientName,
        setupFeeGbp: args.agreement.setupFeeGbp,
        messagingFeeGbp: args.agreement.messagingFeeGbp,
        licenceFeeGbp: args.agreement.licenceFeeGbp,
        freeTrialDays: args.agreement.freeTrialDays,
        freeUntilBookings: args.agreement.freeUntilBookings,
        centresCount: args.agreement.centresCount,
        licences: args.agreement.licences as LicenceTier[],
        goLiveDate: args.agreement.goLiveDate,
        effectiveDate: args.signedAt,
        signedByName: args.signedByName,
        signedByPosition: args.signedByPosition,
        signatureImage: args.signatureImage,
        // Final page: the delivery/open/sign chain. Agreements predating this tracking have
        // nulls, and the page prints "Not recorded" rather than inventing history.
        audit: {
          agreementId: args.agreement.id,
          templateVersion: args.agreement.version,
          sentToEmail: args.agreement.sentToEmail,
          sentToSms: args.agreement.sentToSms,
          sentAt: args.agreement.sentAt,
          firstViewedAt: args.agreement.firstViewedAt,
          lastViewedAt: args.agreement.lastViewedAt,
          viewCount: args.agreement.viewCount,
          viewedFromIp: args.agreement.viewedFromIp,
          viewedUserAgent: args.agreement.viewedUserAgent,
          signedFromIp: args.agreement.signedFromIp,
          signedUserAgent: args.agreement.signedUserAgent,
          signerEmail: args.signerEmail,
        },
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
      messagingFeeGbp: parsed.data.messagingFeeGbp,
      freeTrialDays: parsed.data.freeTrialDays ?? null,
      freeUntilBookings: parsed.data.freeUntilBookings ?? null,
      licenceFeeGbp: parsed.data.licenceFeeGbp,
      centresCount: parsed.data.centresCount,
      licences: parsed.data.licences,
      goLiveDate,
      templateSnapshot: '', // populated on send/sign
      issuedByUserId: req.user!.userId,
    },
  });

  return res.status(201).json({ agreement });
});

/**
 * GET /api/agreements/setup-fee/status?session_id=cs_...
 *
 * What the /agreement/paid page asks after Stripe redirects. Unauthenticated by design: the
 * payer often has no login yet, and the session id is the unguessable capability. Returns only
 * what the payer already knows — their own invoice number, amount and whether it's paid.
 *
 * The webhook (not the redirect) is what marks an invoice paid, so 'pending' here is a normal
 * transient state right after payment; the page polls briefly.
 */
router.get('/agreements/setup-fee/status', async (req: Request, res: Response) => {
  const sessionId = typeof req.query.session_id === 'string' ? req.query.session_id : null;
  if (!sessionId || !sessionId.startsWith('cs_')) {
    return res.json({ status: 'unknown', invoiceNumber: null, grossPence: null, clientName: null, payUrl: null });
  }
  const invoice = await prisma.invoice.findFirst({
    where: { kind: 'setup_fee', stripeCheckoutSessionId: sessionId },
    select: { status: true, invoiceNumber: true, total: true, agreementId: true },
  });
  if (!invoice) {
    return res.json({ status: 'unknown', invoiceNumber: null, grossPence: null, clientName: null, payUrl: null });
  }

  // Only hand back a retry link when it's actually unpaid, and only Stripe's own hosted url.
  let payUrl: string | null = null;
  if (invoice.status !== 'paid' && stripeConfigured()) {
    try {
      const session = await getStripeClient().checkout.sessions.retrieve(sessionId);
      // An expired or already-completed session's url is useless — don't offer a dead button.
      payUrl = session.status === 'open' ? session.url : null;
    } catch {
      payUrl = null;
    }
  }

  const agreement = invoice.agreementId
    ? await prisma.agreement.findUnique({ where: { id: invoice.agreementId }, select: { clientName: true } })
    : null;

  return res.json({
    status: invoice.status === 'paid' ? 'paid' : 'pending',
    invoiceNumber: invoice.invoiceNumber,
    grossPence: invoice.total,
    clientName: agreement?.clientName ?? null,
    payUrl,
  });
});

const previewSchema = draftSchema.omit({ userId: true, businessId: true });

/**
 * POST /api/admin/agreements/preview
 *
 * Render the agreement from draft terms and return the HTML — no Agreement row, no sign token,
 * no email, nothing persisted. Deliberately side-effect free: creating a draft immediately gates
 * that customer's login, so "let me read the wording first" must not cost them anything.
 */
router.post('/admin/agreements/preview', authenticate, requireAdmin, async (req: Request, res: Response) => {
  const parsed = previewSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid terms', details: parsed.error.flatten() });
  }
  const d = parsed.data;
  const html = renderAgreementHtml({
    clientName: d.clientName,
    setupFeeGbp: d.setupFeeGbp,
    licenceFeeGbp: d.licenceFeeGbp,
    messagingFeeGbp: d.messagingFeeGbp,
    freeTrialDays: d.freeTrialDays ?? null,
    freeUntilBookings: d.freeUntilBookings ?? null,
    centresCount: d.centresCount,
    licences: d.licences as LicenceTier[],
    goLiveDate: d.goLiveDate ? new Date(d.goLiveDate) : null,
    effectiveDate: null,
    signedByName: null,
    signedByPosition: null,
    signatureImage: null,
  });

  // Computed the same way the contract computes it, so the UI can't quote a total the document
  // disagrees with.
  const perBranch = d.licenceFeeGbp + d.messagingFeeGbp;
  return res.json({
    html,
    css: AGREEMENT_CSS,
    version: TEMPLATE_VERSION,
    summary: {
      voicePerBranchGbp: d.licenceFeeGbp,
      messagingPerBranchGbp: d.messagingFeeGbp,
      perBranchGbp: perBranch,
      centresCount: d.centresCount,
      monthlyTotalGbp: perBranch * d.centresCount,
      setupFeeGbp: d.setupFeeGbp,
    },
  });
});

/**
 * POST /api/admin/agreements/:id/send
 * Send the magic-link sign email to the customer.
 */
const sendOptionsSchema = z.object({
  // Send the link to a different address than the portal account holder — the signer is often
  // not the portal user. Doesn't touch their login.
  toEmail: z.string().trim().email().max(254).optional(),
  // Also text the link. Optional; the email is always sent.
  toSms: z.string().trim().max(30).optional(),
});

router.post('/admin/agreements/:id/send', authenticate, requireAdmin, async (req: Request, res: Response) => {
  const opts = sendOptionsSchema.safeParse(req.body ?? {});
  if (!opts.success) {
    return res.status(400).json({ error: 'toEmail must be a valid email address.' });
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

  const recipient = opts.data.toEmail || agreement.user.email;
  const sent = await sendAgreementSignEmail({
    to: recipient,
    clientName: agreement.clientName,
    signUrl,
  });
  if (!sent) {
    return res.status(500).json({ error: `Failed to send the email to ${recipient}` });
  }

  // Optional: text the same link. Best-effort — the email is the delivery that matters, so a
  // bad number reports back rather than failing the send.
  let smsTo: string | null = null;
  let smsError: string | null = null;
  if (opts.data.toSms) {
    if (!toE164UK(opts.data.toSms)) {
      smsError = `"${opts.data.toSms}" isn't a valid mobile number — the email was still sent.`;
    } else {
      smsTo = await sendCustomerSms(
        opts.data.toSms,
        `Your ReceptionMate agreement is ready to sign: ${signUrl} (link valid 14 days)`,
      );
      if (!smsTo) smsError = `The email was sent, but the text to ${opts.data.toSms} failed.`;
    }
  }

  await prisma.agreement.update({
    where: { id: agreement.id },
    data: {
      status: 'sent',
      // Record WHERE it went and WHEN — the first link in the audit chain. Resending overwrites,
      // which is correct: the live link is the one that matters, and the audit page should show
      // where the SIGNED link actually went.
      sentToEmail: recipient,
      sentToSms: smsTo,
      sentAt: new Date(),
    },
  });

  // GarageHive garages: also email the diary-connect link so GarageHive can paste the instance and
  // we auto-wire every branch. Best-effort, fire-and-forget — never blocks or fails the send.
  if (agreement.businessId) {
    const businessId = agreement.businessId;
    void (async () => {
      try {
        if (await businessUsesGarageHive(businessId)) {
          const ghToken = signConnectToken(businessId);
          const connectUrl = `${PORTAL_URL}/connect-garagehive?token=${encodeURIComponent(ghToken)}`;
          const ghText =
            `${agreement.clientName} is being onboarded to ReceptionMate Automate.\n\n` +
            `Open this link and paste the garage's GarageHive instance — that's all that's needed. ` +
            `We match the branch(es) by name and connect the diary automatically:\n\n${connectUrl}\n\n(Link valid 14 days.)`;
          await sendEmail({
            to: ['dantyldesley@hotmail.co.uk'],
            subject: `Connect ${agreement.clientName} to ReceptionMate (GarageHive)`,
            text: ghText,
            html:
              `<p>${agreement.clientName} is being onboarded to ReceptionMate Automate.</p>` +
              `<p>Open this link and paste the garage's GarageHive <strong>instance</strong> — that's all that's needed. ` +
              `We match the branch(es) by name and connect the diary automatically:</p>` +
              `<p><a href="${connectUrl}">${connectUrl}</a></p><p style="color:#64748b">(Link valid 14 days.)</p>`,
          });
        }
      } catch (e) {
        console.error('[GH-CONNECT] send-link hook failed:', e);
      }
    })();
  }

  return res.json({ success: true, signUrl, sentToEmail: recipient, sentToSms: smsTo, smsError });
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
/**
 * GET /api/admin/agreements/:id/view
 *
 * The exact document — the signed HTML snapshot where one exists, else the live render of the
 * stored terms. Returned as a full HTML page so staff can read (and print) the actual contract,
 * not just its status. The snapshot has always been kept; nothing ever served it until now.
 */
router.get('/admin/agreements/:id/view', authenticate, requireAdmin, async (req: Request, res: Response) => {
  const agreement = await prisma.agreement.findUnique({ where: { id: req.params.id }, include: { user: true } });
  if (!agreement) return res.status(404).send('Agreement not found');

  const html = agreement.templateSnapshot && agreement.templateSnapshot.length > 0
    ? agreement.templateSnapshot
    : buildSnapshot({
        type: agreement.type,
        clientName: agreement.clientName,
        setupFeeGbp: agreement.setupFeeGbp,
        licenceFeeGbp: agreement.licenceFeeGbp,
        messagingFeeGbp: agreement.messagingFeeGbp,
        freeTrialDays: agreement.freeTrialDays,
        freeUntilBookings: agreement.freeUntilBookings,
        centresCount: agreement.centresCount,
        licences: agreement.licences,
        goLiveDate: agreement.goLiveDate,
      });

  const banner = agreement.signedAt
    ? `Signed by ${agreement.signedByName ?? '—'} on ${new Date(agreement.signedAt).toLocaleString('en-GB')} · v${agreement.version}`
    : `Status: ${agreement.status} · not yet signed · v${agreement.version}`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.send(`<!doctype html><html><head><meta charset="utf-8">
    <title>Agreement — ${agreement.clientName}</title><style>${AGREEMENT_CSS}
    body{margin:0;padding:24px;background:#f1f2f9}
    .rm-view-bar{max-width:820px;margin:0 auto 16px;padding:10px 16px;border-radius:10px;
      background:#eef0fe;border:1px solid #dde0fd;color:#281eb0;font:13px/1.5 -apple-system,sans-serif}
    .rm-view-doc{max-width:820px;margin:0 auto;background:#fff;padding:32px;border-radius:10px}
    @media print{.rm-view-bar{display:none}.rm-view-doc{box-shadow:none;padding:0}body{padding:0;background:#fff}}
    </style></head><body>
    <div class="rm-view-bar">${banner}</div>
    <div class="rm-view-doc">${html}</div></body></html>`);
});

/**
 * GET /api/admin/agreements/:id/pdf
 *
 * The signed PDF, regenerated on demand from the same snapshot + audit trail that was emailed at
 * signing — so it's byte-for-byte the document the customer holds, available any time.
 */
router.get('/admin/agreements/:id/pdf', authenticate, requireAdmin, async (req: Request, res: Response) => {
  const agreement = await prisma.agreement.findUnique({ where: { id: req.params.id }, include: { user: true } });
  if (!agreement) return res.status(404).json({ error: 'Agreement not found' });

  const pdf = await renderAgreementPdf({
    bodyHtml: agreement.templateSnapshot || null,
    clientName: agreement.clientName,
    setupFeeGbp: agreement.setupFeeGbp,
    messagingFeeGbp: agreement.messagingFeeGbp,
    licenceFeeGbp: agreement.licenceFeeGbp,
    freeTrialDays: agreement.freeTrialDays,
    freeUntilBookings: agreement.freeUntilBookings,
    centresCount: agreement.centresCount,
    licences: agreement.licences as LicenceTier[],
    goLiveDate: agreement.goLiveDate,
    effectiveDate: agreement.signedAt,
    signedByName: agreement.signedByName ?? '',
    signedByPosition: '',
    signatureImage: agreement.signatureImage,
    audit: {
      agreementId: agreement.id,
      templateVersion: agreement.version,
      sentToEmail: agreement.sentToEmail,
      sentToSms: agreement.sentToSms,
      sentAt: agreement.sentAt,
      firstViewedAt: agreement.firstViewedAt,
      lastViewedAt: agreement.lastViewedAt,
      viewCount: agreement.viewCount,
      viewedFromIp: agreement.viewedFromIp,
      viewedUserAgent: agreement.viewedUserAgent,
      signedFromIp: agreement.signedFromIp,
      signedUserAgent: agreement.signedUserAgent,
      signerEmail: agreement.signedByEmail,
    },
  });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="ReceptionMate-Agreement-${slugify(agreement.clientName)}.pdf"`);
  return res.send(pdf);
});

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
