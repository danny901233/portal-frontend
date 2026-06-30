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
import { sendEmail } from '../utils/email.js';
import { createFirstMonthCheckoutSession, stripeConfigured } from '../services/stripe.js';
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

  if (!tokenRow || tokenRow.consumedAt || tokenRow.expiresAt < new Date()) {
    return res.status(404).json({ error: 'Sign link not found or expired' });
  }
  if (!tokenRow.agreementId) {
    return res.status(404).json({ error: 'Sign link has no agreement' });
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
  if (!tokenRow || tokenRow.consumedAt || tokenRow.expiresAt < new Date()) {
    return res.status(404).json({ error: 'Sign link not found or expired' });
  }
  if (!tokenRow.agreementId) {
    return res.status(404).json({ error: 'Sign link has no agreement' });
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

  // Public-signup customers (mustChangePassword === true) are routed to
  // Stripe Checkout for their first month's payment. Provisioning + welcome
  // email both fire from the Stripe webhook after payment lands.
  let checkoutUrl: string | null = null;
  if (user?.mustChangePassword && stripeConfigured()) {
    try {
      const garageId = user.garageAccessIds?.[0] ?? null;
      if (garageId) {
        const session = await createFirstMonthCheckoutSession({
          userId: user.id,
          email: user.email,
          businessName: agreement.clientName,
          garageId,
          agreementId: agreement.id,
        });
        checkoutUrl = session.url ?? null;
      } else {
        console.warn('[AGREEMENT_SIGN] public-signup user has no garage — skipping Stripe Checkout');
      }
    } catch (e) {
      console.error('[AGREEMENT_SIGN] Stripe Checkout session create failed:', e);
    }
  }

  // After signing: tell the frontend what the next gate is so it can route
  // straight into DD setup or the dashboard without bouncing through /login.
  const nextStep: 'payment' | 'dashboard' = user?.mustSetupPayment ? 'payment' : 'dashboard';

  return opts.res.json({
    success: true,
    nextStep,
    // When set, the marketing-flow customer should be redirected here to
    // pay for their first month before being onboarded.
    checkoutUrl,
    agreement: {
      id: updated.id,
      status: updated.status,
      signedAt: updated.signedAt,
      signedByName: updated.signedByName,
    },
  });
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
router.post('/admin/agreements/:id/send', authenticate, requireAdmin, async (req: Request, res: Response) => {
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

  const subject = 'Your ReceptionMate service agreement is ready to sign';
  const html = `
    <div style="font-family:Inter,system-ui,sans-serif;max-width:560px;margin:0 auto;color:#0f172a;">
      <h2 style="color:#3426cf;margin:0 0 12px;">Hi ${escapeForEmail(agreement.clientName)},</h2>
      <p>Your ReceptionMate service agreement is ready. Click the button below to review the terms and sign — it should only take a minute.</p>
      <p style="text-align:center;margin:28px 0;">
        <a href="${signUrl}" style="display:inline-block;background:#3426cf;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;">Review and sign</a>
      </p>
      <p style="color:#475569;font-size:14px;">This link is valid for 14 days. If you have any questions, reply to this email.</p>
      <p style="margin-top:32px;color:#64748b;font-size:13px;">— The ReceptionMate team</p>
    </div>
  `;
  const text = `Your ReceptionMate service agreement is ready to sign.\n\nReview and sign here: ${signUrl}\n\nThis link is valid for 14 days.\n\n— The ReceptionMate team`;

  const sent = await sendEmail({ to: [agreement.user.email], subject, html, text });
  if (!sent) {
    return res.status(500).json({ error: 'Failed to send email' });
  }

  await prisma.agreement.update({
    where: { id: agreement.id },
    data: { status: 'sent' },
  });

  return res.json({ success: true, signUrl });
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
