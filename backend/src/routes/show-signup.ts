// Self-serve Automate signup for the Garage Hive Blend show (October 2026).
//
// The flyer QR points at /blend on the marketing site, which walks the prospect through the
// same first two steps as get-started (garage search -> HighLevel lead via /public/prospect,
// then the GMS question) and lands here once they accept the offer:
//
//     Automate, £399 per branch per month, free until the AI books 4 customers.
//
// WHAT THIS ENDPOINT DOES — and deliberately does not do.
//
// It creates the account SILENTLY, exactly as Quick Onboard does for a sales-led deal
// (onboardingStage 'awaiting_agreement', no welcome email, no Twilio number), then drafts the
// agreement and hands back a sign link. Nothing is emailed to the customer here: they go
// straight from the funnel to /agreement/sign, and signing is what triggers the real onboarding
// — sendGarageHiveConnectRequest / sendDiaryConnectRequest ask the GMS for API credentials,
// the garage gets its "getting ready" note, and the stage moves to awaiting_credentials. All of
// that already lives in finaliseSignature (routes/agreements.ts) and is reused untouched, which
// is the whole reason the account is created BEFORE the signature rather than after it: the
// deferred-account path used by Assist self-serve (finalisePendingSignature) runs none of it.
//
// The cost of that choice is an account that exists before anyone has signed. That is what
// 'awaiting_agreement' means and the onboarding pipeline already lists it, so an abandoned
// signup is visible rather than lost — and because no number is bought, it costs nothing.
//
// Automate cannot answer calls until the GMS credentials come back from the provider, so NO
// Twilio number is provisioned here. A garage_hive agent with no Business Central credentials
// serves a fake "Volkswagen Golf KX20HGF" fixture and breaks the booking, so a live number on
// an uncredentialed garage is worse than no number at all.

import type { Request, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { prisma } from '../db.js';
import { issueSignLinkToken, SELF_SERVE_SIGN_PURPOSE } from './agreements.js';
import { ensureAdminAccessToGarage } from './admin.js';
import { sendAgentConfigWebhook } from './config.js';
import { sendEmail, brandedEmailShell, SUPPORT_REPLY_TO } from '../utils/email.js';
import { fetchPlaceDetails } from '../utils/googlePlaces.js';
import { industryDefaultFaqs, generateFaqsFromWebsite } from '../utils/faqGenerator.js';
import { TEMPLATE_VERSION } from '../services/agreementTemplate.js';
import { highlevelConfigured, upsertContact, updateContact, createOpportunity } from '../services/highlevel.js';
import type { Prisma } from '@prisma/client';

const router = Router();

const PORTAL_URL = process.env.PORTAL_URL || 'https://portal.receptionmate.co.uk';
// Where an interested-but-not-today garage is sent back to. The site answers on both the apex
// and www with no redirect between them; www is canonical, so link to that.
const BLEND_URL = process.env.BLEND_URL || 'https://www.receptionmate.co.uk/blend';

// A garage name is typed by whoever is signing up, and these emails go out from our domain.
const esc = (v: string): string =>
  v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * Escaping stops a garage name becoming markup. It does not stop it becoming a SENTENCE.
 *
 * /public/show-interest emails anyone who asks, so the name is attacker-chosen text delivered
 * from our domain to an address of their choosing — "Your account is suspended, call 0800…"
 * reads very differently under our logo than it would from a stranger. So the name is reduced to
 * the characters a garage name actually needs and cut short: no colons or slashes means no URL,
 * and 60 characters is a name rather than a paragraph.
 */
export function safeGarageName(v: string): string {
  // Applied at the INPUT boundary, so what we STORE is already a garage name.
  //
  // safeDisplayName below guards the two emails this file sends. It cannot guard the others: the
  // name is written to Business, Garage and Agreement.clientName, and from there it reaches the
  // credential-request email we send Garage Hive or Tyresoft, and the signed agreement itself.
  // Reducing it only at the point of display left the stored value raw and the differential is
  // the bug — so reduce it once, here, and everything downstream inherits it.
  //
  // Looser than the display rule on purpose: real names carry brackets and slashes ("A/B Motors",
  // "Acme (Leeds)"). What it will not carry is a scheme, a tag or a control character, so the
  // stored name cannot become a link in somebody else's inbox.
  const cleaned = v
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[<>:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, 120);
}

export function safeDisplayName(v: string): string {
  const cleaned = v.replace(/[^\p{L}\p{N} '&.\-]/gu, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.length > 60 ? `${cleaned.slice(0, 60).trimEnd()}…` : cleaned;
}

// NO shared starting password here, unlike admin.ts / public-signup.ts / onboarding-pipeline.ts.
//
// Those paths seed every new account with the same constant and rely on mustChangePassword to
// force a change — but login does not refuse such an account. auth.ts:189 answers a correct
// password with a valid 7-day JWT *and* a resetToken, so anyone who knows the constant can log
// in as that user and then set their own password. On the admin paths that is gated behind staff
// auth; on the Assist path, behind a confirmed Stripe card. This endpoint is unauthenticated and
// takes no payment, so the same constant here would let anyone POST a real garage's email and
// then walk into the account it creates.
//
// So the account is born unusable: a random hash nobody holds the preimage of. The customer
// never needs it — they sign via the magic-link token (no password involved) and finaliseSignature
// then issues a one-time passwordSetupToken, which is the only way in. Someone who abandons
// mid-funnel uses the ordinary forgot-password flow.
const unusablePasswordHash = () => bcrypt.hash(randomBytes(32).toString('hex'), 10);

// The show offer, in one place. These are the live Automate terms (the most common deal on the
// estate is £399 / 600 minutes), NOT a show discount: what is on offer is the free period, so
// nobody who signs at Blend is on a rate that undercuts an existing customer.
export const SHOW_TERMS = {
  subscriptionCostGbp: 399,
  includedMinutes: 600,
  costPerMinuteGbp: 0.25,
  vatRate: 0.2,
  bookingsRequiredForActivation: 4,
} as const;

// Which diary each answer maps to. Every one of them runs the unified agent — that is the
// production standard (20 Garage Hive, 1 Bookar, 1 Tyresoft live on it) and the only script
// that reads integrationProvider; the older scripts are each welded to a single diary.
//
// 'poole' is AutoSage (Poole Software). The provider key is internal shorthand; everything a
// human reads says AutoSage.
export const SUPPORTED_GMS = {
  garagehive: 'garage_hive',
  bookar: 'bookar',
  tyresoft: 'tyresoft',
  autosage: 'poole',
} as const;

export type SupportedGms = keyof typeof SUPPORTED_GMS;

/**
 * The offer, as the customer reads it. One source for both emails and the only place the terms
 * are written in prose — the page states the same numbers, and SHOW_TERMS is what actually gets
 * written to the garage, so a change there is visible here rather than silently contradicting it.
 */
export function offerSummaryHtml(): string {
  const t = SHOW_TERMS;
  return (
    `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="border:1px solid #e2e8f0;border-radius:12px;margin:0 0 20px;">` +
    `<tr><td style="padding:20px;">` +
    `<p style="margin:0 0 4px;font-size:15px;font-weight:700;color:#0f172a;">Automate — £${t.subscriptionCostGbp} per branch / month + VAT</p>` +
    `<p style="margin:0 0 14px;font-size:13px;color:#64748b;">${t.includedMinutes} minutes included · £${t.costPerMinuteGbp.toFixed(2)} per extra minute · rolling monthly, 30 days' notice</p>` +
    `<p style="margin:0;padding:12px;background:#ecfdf5;border-radius:8px;font-size:14px;line-height:1.5;color:#065f46;">` +
    `<strong>Nothing to pay until booking ${t.bookingsRequiredForActivation}.</strong> We set up your Direct Debit, but we don't take a penny ` +
    `until the AI has booked ${t.bookingsRequiredForActivation} customers into your diary. If it never does, you never pay.</p>` +
    `</td></tr></table>`
  );
}

export function offerSummaryText(): string {
  const t = SHOW_TERMS;
  return (
    `Automate - £${t.subscriptionCostGbp} per branch per month + VAT\n` +
    `${t.includedMinutes} minutes included, £${t.costPerMinuteGbp.toFixed(2)} per extra minute. Rolling monthly, 30 days' notice.\n\n` +
    `Nothing to pay until booking ${t.bookingsRequiredForActivation}: we set up your Direct Debit, but take nothing until the AI has ` +
    `booked ${t.bookingsRequiredForActivation} customers into your diary. If it never does, you never pay.`
  );
}

/** "Here's the offer, finish when you're ready" — for someone who didn't sign at the stand. */
export function buildInterestEmail(businessName: string): { subject: string; html: string; text: string } {
  const name = esc(safeDisplayName(businessName));
  const body =
    `<tr><td style="padding:32px;">` +
    `<h1 style="margin:0 0 14px;font-size:20px;color:#0f172a;font-weight:700;">Your Blend offer, ${name}</h1>` +
    `<p style="margin:0 0 20px;font-size:15px;line-height:1.55;color:#475569;">Thanks for stopping by the stand. Here's the offer in writing so you can take your time over it.</p>` +
    offerSummaryHtml() +
    `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 auto 18px;"><tr>` +
    `<td style="background:#3426cf;border-radius:10px;"><a href="${BLEND_URL}" style="display:inline-block;padding:14px 30px;color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;">Set it up when you're ready</a></td>` +
    `</tr></table>` +
    `<p style="margin:0;font-size:14px;line-height:1.55;color:#475569;">It takes about two minutes, and you'll need your bank details for the Direct Debit — which is why it's often easier from the office than the show floor. Any questions, just reply to this email.</p>` +
    `</td></tr>`;
  return {
    subject: 'Your Blend offer — free until the AI books you 4 customers',
    html: brandedEmailShell(body),
    text:
      `Thanks for stopping by the ReceptionMate stand.\n\n${offerSummaryText()}\n\n` +
      `Set it up when you're ready: ${BLEND_URL}\n\n` +
      `It takes about two minutes. You'll need your bank details for the Direct Debit, which is often easier from the office than the show floor.\n\n` +
      `Any questions, just reply to this email.`,
  };
}

/** The sign link, emailed as well as handed to the browser — see the route for why. */
export function buildSignLinkEmail(businessName: string, signUrl: string): { subject: string; html: string; text: string } {
  const name = esc(safeDisplayName(businessName));
  const body =
    `<tr><td style="padding:32px;">` +
    `<h1 style="margin:0 0 14px;font-size:20px;color:#0f172a;font-weight:700;">Finish setting up ${name}</h1>` +
    `<p style="margin:0 0 20px;font-size:15px;line-height:1.55;color:#475569;">Your account is ready. The last step is to read and sign your agreement — it takes a minute.</p>` +
    offerSummaryHtml() +
    `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 auto 18px;"><tr>` +
    `<td style="background:#3426cf;border-radius:10px;"><a href="${signUrl}" style="display:inline-block;padding:14px 30px;color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;">Review and sign</a></td>` +
    `</tr></table>` +
    `<p style="margin:0;font-size:14px;line-height:1.55;color:#475569;">This link is valid for 14 days. After signing you'll choose a password and set up the Direct Debit — you'll need your account number and sort code for that bit.</p>` +
    `</td></tr>`;
  return {
    subject: `Finish setting up ${safeDisplayName(businessName)} — your ReceptionMate agreement`,
    html: brandedEmailShell(body),
    text:
      `Your ReceptionMate account is ready. The last step is to read and sign your agreement:\n\n${signUrl}\n\n` +
      `${offerSummaryText()}\n\nThis link is valid for 14 days. After signing you'll choose a password and set up the Direct Debit ` +
      `(you'll need your account number and sort code).`,
  };
}

/**
 * The billing + activation fields every show signup's garage is created with.
 *
 * Pulled out as a pure function so the offer itself is testable. requiresBookingActivation is
 * the one field that MUST be set explicitly: it defaults to false in the schema, and
 * /admin/onboard does not persist it at all (completeOnboardingSchema never declared it, so
 * zod strips what the modal posts). Getting it wrong does not fail loudly — it charges the
 * customer £399 the moment their mandate confirms, against an agreement promising otherwise.
 */
export function showGarageBilling() {
  return {
    subscriptionCostGbp: SHOW_TERMS.subscriptionCostGbp,
    includedMinutes: SHOW_TERMS.includedMinutes,
    costPerMinuteGbp: SHOW_TERMS.costPerMinuteGbp,
    vatRate: SHOW_TERMS.vatRate,
    hasVoiceAccess: true,
    hasMessagingAccess: false,
    requiresBookingActivation: true,
    bookingsRequiredForActivation: SHOW_TERMS.bookingsRequiredForActivation,
    activationBookingsCount: 0,
    subscriptionActivatedAt: null,
    onboardingStage: 'awaiting_agreement',
  } as const;
}

/**
 * The commercial terms written onto the agreement. freeTrialDays stays null and
 * freeUntilBookings carries the count: the template renders the booking clause only when the
 * day count is absent, so setting both would contradict itself on the signed PDF.
 */
export function showAgreementTerms() {
  return {
    setupFeeGbp: 0,
    licenceFeeGbp: SHOW_TERMS.subscriptionCostGbp,
    centresCount: 1,
    messagingFeeGbp: 0,
    licences: ['automate'] as const,
    freeTrialDays: null,
    freeUntilBookings: SHOW_TERMS.bookingsRequiredForActivation,
  } as const;
}

// ---------------------------------------------------------------------------
// Abuse limit.
//
// This endpoint is unauthenticated and takes no payment, and one POST writes a Business, a
// Garage, an AgentConfiguration, a User and an Agreement, then calls Google Places, pushes to
// HighLevel and kicks off an OpenAI FAQ generation. A duplicate email is already refused with
// a 409, so abuse needs a fresh address every time — but nothing else stood between a script
// and a few thousand rows.
//
// The cap is deliberately LOOSE. Everyone signing up at Blend is on the venue wifi and will
// share one source address, so a tight per-IP limit would 429 the genuine queue at the stand —
// which is the one failure mode that costs real money this weekend. Twelve an hour from a
// single address is a better day than we expect to have and still bounds a script hard.
//
// cf-connecting-ip, not x-forwarded-for[0]: Cloudflare APPENDS the real peer to whatever the
// caller sent, so chain[0] is attacker-controlled and limiting on it is a no-op. That exact
// mistake was found and fixed in public-prospect.ts; this follows the fixed version.
const IP_MAX = 12;
const IP_WINDOW_MS = 60 * 60 * 1000;
type Bucket = { count: number; windowStart: number; last: number };
const byIp = new Map<string, Bucket>();

// …and a cap per RECIPIENT, which the IP limit does not give. Rotating addresses defeats a
// per-IP limit, and the thing worth protecting is a victim's inbox (and our sending domain's
// reputation) rather than any one source. Two is enough for a genuine "it didn't arrive".
const RECIPIENT_MAX = 2;
const byRecipient = new Map<string, Bucket>();

function clientIp(req: Request): string {
  const cf = (req.headers['cf-connecting-ip'] as string | undefined)?.trim();
  if (cf) return cf;
  const chain = (req.headers['x-forwarded-for'] as string | undefined)?.split(',') ?? [];
  return chain[chain.length - 1]?.trim() || req.ip || 'unknown';
}

/** Returns seconds to wait when over the limit, or null when the request may proceed. */
function throttled(ip: string): number | null {
  const now = Date.now();
  const b = byIp.get(ip);
  if (!b || now - b.windowStart >= IP_WINDOW_MS) {
    byIp.set(ip, { count: 1, windowStart: now, last: now });
    return null;
  }
  b.last = now;
  if (b.count >= IP_MAX) return Math.max(1, Math.ceil((b.windowStart + IP_WINDOW_MS - now) / 1000));
  b.count += 1;
  return null;
}

function throttledKey(map: Map<string, Bucket>, key: string, max: number): number | null {
  const now = Date.now();
  const b = map.get(key);
  if (!b || now - b.windowStart >= IP_WINDOW_MS) {
    map.set(key, { count: 1, windowStart: now, last: now });
    return null;
  }
  b.last = now;
  if (b.count >= max) return Math.max(1, Math.ceil((b.windowStart + IP_WINDOW_MS - now) / 1000));
  b.count += 1;
  return null;
}

// Sweep hourly so the maps cannot grow without bound. unref() so it never holds the process open.
setInterval(() => {
  const cutoff = Date.now() - IP_WINDOW_MS;
  for (const map of [byIp, byRecipient]) {
    for (const [k, b] of map) if (b.last < cutoff) map.delete(k);
  }
}, 60 * 60 * 1000).unref();

const showSignupSchema = z.object({
  // The prospect row from step 1 (/public/prospect). Optional so the endpoint still works if
  // the funnel is entered directly, but in practice it is always present and carries the
  // HighLevel opportunity we must attach to the garage.
  prospectId: z.string().trim().max(80).optional(),
  businessName: z.string().trim().min(2).max(200).transform(safeGarageName),
  googlePlaceId: z.string().trim().max(200).optional(),
  address: z.string().trim().max(500).optional(),
  name: z.string().trim().min(2).max(120).transform(safeGarageName),
  email: z.string().trim().email().max(254),
  phone: z.string().trim().min(6).max(40),
  gms: z.enum(['garagehive', 'bookar', 'tyresoft', 'autosage']),
});

/**
 * POST /api/public/show-signup
 *
 * Creates the account + draft agreement and returns the URL to sign it. Public and CORS-open
 * (server.ts exempts /api/public/*), so it is called straight from the marketing site.
 */
router.post('/public/show-signup', async (req: Request, res: Response) => {
  const parsed = showSignupSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: 'invalid_request', details: parsed.error.flatten() });
  }

  const wait = throttled(clientIp(req));
  if (wait !== null) {
    console.warn(`[SHOW-SIGNUP] rate-limited ip=${clientIp(req)}`);
    res.setHeader('Retry-After', String(wait));
    return res.status(429).json({
      success: false,
      error: 'rate_limited',
      retryAfter: wait,
      message: "Too many sign-ups from this connection. Grab one of us at the stand and we'll finish it for you.",
    });
  }

  const { prospectId, businessName, googlePlaceId, address, name, phone, gms } = parsed.data;
  const email = parsed.data.email.toLowerCase();
  const integrationProvider = SUPPORTED_GMS[gms as SupportedGms];

  try {
    // Reject a duplicate email BEFORE creating anything, so a collision cannot leave an
    // orphaned business + garage + agreement behind. Same guard, and same reason, as
    // /admin/onboard step 0.
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.status(409).json({
        success: false,
        error: 'email_in_use',
        message: 'This email already has an account. Please sign in instead.',
        loginUrl: `${PORTAL_URL}/login`,
      });
    }

    // Pull the Google listing once. Non-fatal: a slow or unhappy Google must never cost us a
    // signup at the stand — it only means the agent starts with blank hours.
    let place: Awaited<ReturnType<typeof fetchPlaceDetails>> = null;
    if (googlePlaceId) {
      try {
        place = await fetchPlaceDetails(googlePlaceId);
      } catch (e) {
        console.error('[SHOW-SIGNUP] place lookup failed:', e);
      }
    }

    // The prospect row from step 1, for the HighLevel opportunity it already owns.
    const prospect = prospectId
      ? await prisma.pendingSignup.findUnique({ where: { id: prospectId } })
      : null;

    const business = await prisma.business.create({
      data: {
        name: businessName,
        // Direct Debit: they set the mandate up on /setup-payment straight after signing.
        billingMethod: 'directdebit',
        combinedInvoicing: true,
        contactName: name,
        contactEmail: email,
        contactPhone: phone,
        contactRole: 'Owner',
      },
    });

    const garage = await prisma.garage.create({
      data: {
        name: businessName,
        businessId: business.id,
        // THE OFFER — see showGarageBilling(). onboardingStage 'awaiting_agreement' matters as
        // much as the activation flags: left at the 'live' default, setOnboardingStage refuses
        // to move the garage and it could never enter the pipeline at all.
        ...showGarageBilling(),
        // Carry the opportunity from step 1 so every later stage change mirrors into HighLevel.
        ghlOpportunityId: prospect?.ghlOpportunityId ?? null,
      },
    });

    const greetingLine = `[timeofday], ${businessName}, Leah speaking, how can I help?`;
    await prisma.agentConfiguration.create({
      data: {
        garageId: garage.id,
        branchName: businessName,
        ...(place?.address || address ? { branchAddress: place?.address || address } : {}),
        ...(place?.phone ? { phoneNumber: place.phone } : {}),
        ...(place?.website ? { websiteUrl: place.website } : {}),
        businessType: place?.businessType || null,
        ...(place?.weeklyOpeningHours
          ? { weeklyOpeningHours: place.weeklyOpeningHours as Prisma.InputJsonValue }
          : {}),
        greetingLine,
        faqs: industryDefaultFaqs(businessName) as unknown as Prisma.InputJsonValue,
        tonePreference: 'standard',
        responseSpeed: 'normal',
        interruptionSensitivity: 0.5,
        allowFastFitOnly: false,
        agentScript: 'unified-agent',
        integrationProvider,
      },
    });

    await ensureAdminAccessToGarage(garage.id).catch((err) =>
      console.error('[SHOW-SIGNUP] ensureAdminAccessToGarage failed:', err),
    );

    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: await unusablePasswordHash(),
        // They choose their own password immediately after signing.
        mustChangePassword: true,
        // Gates them onto /setup-payment for the Direct Debit mandate on first login.
        mustSetupPayment: true,
        mustSignAgreement: true,
        garageAccessIds: [garage.id],
        role: 'USER',
        // resolveCustomerUser looks for the branch MANAGER to tell the customer apart from the
        // staff accounts ensureAdminAccessToGarage just added, so this is load-bearing.
        branchRoles: { [garage.id]: 'MANAGER' },
      },
    });

    // The agreement. Marked 'sent' rather than 'draft' because the customer is being handed the
    // link right now — the funnel is the delivery, so sentAt is the truth and the onboarding
    // pipeline's chase data reads correctly.
    const agreement = await prisma.agreement.create({
      data: {
        type: 'saas',
        version: TEMPLATE_VERSION,
        status: 'sent',
        userId: user.id,
        businessId: business.id,
        clientName: businessName,
        ...showAgreementTerms(),
        licences: [...showAgreementTerms().licences],
        messagingCentresCount: null,
        goLiveDate: null,
        templateSnapshot: '', // populated at signature
        // sentAt stays NULL until the link is actually emailed. The customer is handed it in the
        // browser, so nothing has been sent yet, and claiming otherwise would both misreport the
        // onboarding pipeline's chase data and make the sweep below think it had already run.
        sentAt: null,
        sentToEmail: email,
      },
    });

    // The self-serve purpose: signing this link also mints a password-setup token, because the
    // customer has no password and was sent no welcome email. An ordinary 'sign_agreement' link
    // must never carry that, so the capability rides on the token.
    const token = await issueSignLinkToken(user.id, agreement.id, SELF_SERVE_SIGN_PURPOSE);
    const signUrl = `${PORTAL_URL}/agreement/sign?token=${encodeURIComponent(token)}`;

    // Stop the abandoned-checkout chase emails: this prospect converted.
    if (prospect && prospect.status !== 'completed') {
      await prisma.pendingSignup.update({
        where: { id: prospect.id },
        data: { status: 'completed', createdGarageId: garage.id, product: 'automate', email, name, contactPhone: phone },
      });
    }

    // HighLevel, best-effort and never on the critical path. Enrich the step-1 contact if we
    // have one; otherwise create the opportunity now so a direct entry still lands in the CRM.
    void (async () => {
      if (!highlevelConfigured()) return;
      try {
        let contactId = prospect?.ghlContactId ?? null;
        if (contactId) {
          await updateContact(contactId, { name, email, phone, website: place?.website ?? undefined });
        } else {
          const contact = await upsertContact({
            name,
            email,
            phone,
            companyName: businessName,
            website: place?.website ?? undefined,
            source: 'blend-show',
            tags: ['blend-2026', 'website-signup', 'automate'],
          });
          contactId = contact.contactId;
        }
        if (contactId && !prospect?.ghlOpportunityId) {
          const opp = await createOpportunity({
            contactId,
            name: `${businessName} — Automate (Blend)`,
            monetaryValueGbp: SHOW_TERMS.subscriptionCostGbp,
            monthlyCostPerBranchGbp: SHOW_TERMS.subscriptionCostGbp,
            packageName: 'Automate',
            kind: 'signup',
          });
          if (opp.id) {
            await prisma.garage.update({ where: { id: garage.id }, data: { ghlOpportunityId: opp.id } });
          }
        }
      } catch (e) {
        console.error('[SHOW-SIGNUP] HighLevel sync failed:', e);
      }
    })();

    // Tailor the seeded FAQs from the garage's own website in the background. Far too slow to
    // hold the response open, and the defaults are already live if it never finishes.
    if (place?.website) {
      const site = place.website;
      const gid = garage.id;
      void (async () => {
        try {
          const faqs = await generateFaqsFromWebsite(site, businessName, place?.weeklyOpeningHours);
          if (faqs.length >= 3) {
            await prisma.agentConfiguration.update({
              where: { garageId: gid },
              data: { faqs: faqs as unknown as Prisma.InputJsonValue },
            });
            await sendAgentConfigWebhook(gid).catch(() => {});
          }
        } catch (e) {
          console.error('[SHOW-SIGNUP] background FAQ generation failed:', e);
        }
      })();
    }

    // The sign link is NOT emailed here — see sweepUnsignedShowAgreements below. Somebody who is
    // on the signing page right now does not need an email telling them to go to it.

    console.log(
      `[SHOW-SIGNUP] ${businessName} (${gms} -> ${integrationProvider}) garage=${garage.id} agreement=${agreement.id} — ready to sign`,
    );
    return res.status(201).json({ success: true, signUrl, businessName });
  } catch (error) {
    console.error('[SHOW-SIGNUP] failed:', error);
    return res.status(500).json({ success: false, error: 'server_error' });
  }
});

/**
 * POST /api/public/show-interest
 *
 * "Send me the details instead" — for a garage that wants the offer but not today.
 *
 * Creates NO account, no agreement and no sign link: they have committed to nothing, and an
 * account created on their behalf is exactly the squatting problem we already carry on the
 * signup route. All this does is make the lead contactable (the prospect row from the garage
 * search has a business name and nothing else) and put the offer in their inbox so there is a
 * way back that does not depend on them remembering a URL.
 */
const interestSchema = z.object({
  prospectId: z.string().trim().max(80).optional(),
  businessName: z.string().trim().min(2).max(200).transform(safeGarageName),
  name: z.string().trim().min(2).max(120).transform(safeGarageName),
  email: z.string().trim().email().max(254),
  phone: z.string().trim().min(6).max(40),
  // Their diary, when we know it — a supported one means they saw the offer and hesitated,
  // which is a different follow-up from "we cannot integrate yet".
  gms: z.string().trim().max(60).optional(),
  address: z.string().trim().max(500).optional(),
});

router.post('/public/show-interest', async (req: Request, res: Response) => {
  const parsed = interestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: 'invalid_request', details: parsed.error.flatten() });
  }

  const wait = throttled(clientIp(req));
  if (wait !== null) {
    res.setHeader('Retry-After', String(wait));
    return res.status(429).json({ success: false, error: 'rate_limited', retryAfter: wait });
  }

  const { prospectId, businessName, name, phone, gms, address } = parsed.data;
  const email = parsed.data.email.toLowerCase();

  const recipientWait = throttledKey(byRecipient, email, RECIPIENT_MAX);
  if (recipientWait !== null) {
    // Answer as though it sent. Telling a sender which addresses have already been mailed turns
    // this into an account-existence oracle, and a genuine person who double-taps should not be
    // told off — they already have the email.
    console.warn(`[SHOW-INTEREST] recipient cap reached for ${email} — not sending again`);
    return res.status(201).json({ success: true, emailed: true });
  }

  try {
    const mail = buildInterestEmail(businessName);
    const sent = await sendEmail({
      to: [email],
      replyTo: SUPPORT_REPLY_TO,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      template: 'show_interest_offer',
    });

    // The CRM push is best-effort and must not fail the request: the person is standing in front
    // of us and the email is the thing they were promised.
    void (async () => {
      if (!highlevelConfigured()) return;
      try {
        const prospect = prospectId
          ? await prisma.pendingSignup.findUnique({ where: { id: prospectId } })
          : null;
        let contactId = prospect?.ghlContactId ?? null;
        if (contactId) {
          await updateContact(contactId, { name, email, phone });
        } else {
          const c = await upsertContact({
            name,
            email,
            phone,
            companyName: businessName,
            source: 'blend-show',
            tags: ['blend-2026', 'blend-interested', 'automate'],
          });
          contactId = c.contactId;
        }
        if (contactId && !prospect?.ghlOpportunityId) {
          await createOpportunity({
            contactId,
            name: `${businessName} — Automate (Blend, to follow up)`,
            monetaryValueGbp: SHOW_TERMS.subscriptionCostGbp,
            monthlyCostPerBranchGbp: SHOW_TERMS.subscriptionCostGbp,
            packageName: 'Automate',
            kind: 'lead',
          });
        }
        if (prospect) {
          await prisma.pendingSignup.update({
            where: { id: prospect.id },
            data: { name, email, contactPhone: phone, product: 'automate' },
          });
        }
      } catch (e) {
        console.error('[SHOW-INTEREST] CRM sync failed:', e);
      }
    })();

    console.log(`[SHOW-INTEREST] ${businessName} (${gms || 'gms unknown'}) -> ${email} — offer emailed=${sent}${address ? '' : ''}`);
    return res.status(201).json({ success: true, emailed: sent });
  } catch (error) {
    console.error('[SHOW-INTEREST] failed:', error);
    return res.status(500).json({ success: false, error: 'server_error' });
  }
});

/**
 * Chase a show signup who created an account and then did not sign.
 *
 * The sign link used to be emailed the moment the account was created, which meant it landed
 * while the customer was still looking at the agreement — an email telling them to go to the page
 * they were already on. It is a backup for the ones who walk away, so it waits.
 *
 * Sends once, after SIGN_CHASE_AFTER_MS, and only while the agreement is still unsigned. The
 * marker is the agreement's own `sentAt`: null means nothing has been emailed, and setting it
 * when we send both stops a second attempt and restores that column's honest meaning for the
 * onboarding pipeline's chase data.
 *
 * Deliberately narrow. Only an agreement created by this funnel qualifies — status 'sent' with no
 * sentAt AND a live self-serve sign token — so a staff-drafted agreement, which is 'draft' until
 * somebody sends it, can never be swept into an automatic email.
 */
const SIGN_CHASE_AFTER_MS = 5 * 60 * 1000;

export async function sweepUnsignedShowAgreements(): Promise<number> {
  const cutoff = new Date(Date.now() - SIGN_CHASE_AFTER_MS);
  const due = await prisma.agreement.findMany({
    where: {
      status: 'sent',
      sentAt: null,
      createdAt: { lt: cutoff },
      freeUntilBookings: { not: null },
    },
    select: { id: true, clientName: true, sentToEmail: true, businessId: true, userId: true },
    take: 50,
  });
  if (!due.length) return 0;

  let sent = 0;
  for (const a of due) {
    // Reuse the token the customer was already given rather than minting another: a second live
    // link for the same agreement is a second way into the account.
    const tokenRow = await prisma.signLinkToken.findFirst({
      where: {
        agreementId: a.id,
        userId: a.userId,
        purpose: SELF_SERVE_SIGN_PURPOSE,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
      select: { token: true },
    });
    const to = a.sentToEmail;
    if (!tokenRow || !to) {
      // Nothing to send them to. Mark it so the sweep does not reconsider this row every minute.
      await prisma.agreement.update({ where: { id: a.id }, data: { sentAt: new Date() } });
      console.warn(`[SHOW-SIGNUP] no live sign token for agreement ${a.id} — chase skipped`);
      continue;
    }

    const signUrl = `${PORTAL_URL}/agreement/sign?token=${encodeURIComponent(tokenRow.token)}`;
    const mail = buildSignLinkEmail(a.clientName, signUrl);
    const ok = await sendEmail({
      to: [to],
      replyTo: SUPPORT_REPLY_TO,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      template: 'show_signup_sign_link',
      ...(a.businessId ? { businessId: a.businessId } : {}),
    }).catch((e) => {
      console.error('[SHOW-SIGNUP] chase email failed:', e);
      return false;
    });

    // Only claim it was sent if it was. A transient Mailgun failure should be retried next run.
    if (ok) {
      await prisma.agreement.update({ where: { id: a.id }, data: { sentAt: new Date() } });
      sent += 1;
    }
  }
  if (sent) console.log(`[SHOW-SIGNUP] chased ${sent} unsigned agreement(s)`);
  return sent;
}

export default router;
