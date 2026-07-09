import type { Request, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { prisma } from '../db.js';
import { sendEmail } from '../utils/email.js';
import { TEMPLATE_VERSION } from '../services/agreementTemplate.js';
import { pushSignupToHighlevel } from '../services/highlevel.js';
import { ensureAdminAccessToGarage } from './admin.js';
import { fetchPlaceDetails } from '../utils/googlePlaces.js';
import { industryDefaultFaqs, generateFaqsFromWebsite } from '../utils/faqGenerator.js';
import { autoIngestWebsiteKnowledge } from './config.js';
import type { Prisma } from '@prisma/client';

const router = Router();

// Public marketing-site signup. Creates a new Business + Garage + AgentConfiguration + User
// with Assist defaults. The downstream activation friction (password reset, setup wizard,
// Direct Debit mandate) acts as the real anti-abuse mechanism — no resources are provisioned
// until the customer completes those steps.
const ASSIST_DEFAULTS = {
  subscriptionCostGbp: 200,
  includedMinutes: 400,
  costPerMinuteGbp: 0.25,
  vatRate: 0.2,
};

const PORTAL_URL = process.env.PORTAL_URL || 'https://portal.receptionmate.co.uk';

const publicSignupSchema = z.object({
  businessName: z.string().trim().min(2).max(200),
  email: z.string().trim().email().max(254),
  address: z.string().trim().max(500).optional(),
  googlePlaceId: z.string().trim().max(200).optional(),
  // Customer's personal name. Optional for back-compat; new marketing-site
  // submissions always include it so we can populate HighLevel's contact name.
  name: z.string().trim().min(2).max(120).optional(),
});

// Same fixed temp password for every public signup. `mustChangePassword=true`
// forces a change on first login, so this is just a one-time bootstrap secret
// the welcome email reveals after the user has signed their agreement.
const PUBLIC_SIGNUP_TEMP_PASSWORD = 'Nomoremissedcalls';

// Magic-link sign tokens live for 14 days — long enough that customers don't
// have to chase a re-send, short enough that abandoned signups expire.
const SIGN_LINK_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function escapeForEmail(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

router.post('/public-signup', async (req: Request, res: Response) => {
  const parsed = publicSignupSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: 'invalid_request',
      details: parsed.error.flatten(),
    });
  }

  const { businessName, email, address, googlePlaceId, name } = parsed.data;
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

    // 0. Enrich from the Google Places link. The marketing-site autocomplete only
    //    gives us name + address; the Place Details lookup adds phone, website and
    //    opening hours. Fast (6s timeout) and fully non-fatal — signup proceeds even
    //    if Google is slow or the key lacks a scope.
    const place = await fetchPlaceDetails(googlePlaceId);
    const branchAddress = place?.address || address || null;
    const phoneNumber = place?.phone || null;
    const websiteUrl = place?.website || null;
    const weeklyOpeningHours = place?.weeklyOpeningHours;
    // Default greeting: "Good morning, {garage}, Leah speaking, how can I help?"
    // ([timeofday] is expanded by the agent at runtime). Fully editable in the portal.
    const greetingLine = `[timeofday], ${businessName}, Leah speaking, how can I help?`;
    // Seed industry-standard FAQs immediately; a background job upgrades them from the
    // garage's website (if any) just below.
    const seededFaqs = industryDefaultFaqs(businessName);

    // 1. Business
    const business = await prisma.business.create({
      data: { name: businessName },
    });

    // 2. Garage (with Assist pricing baked in so it's immediately billable
    //    once the user completes Direct Debit setup)
    const garage = await prisma.garage.create({
      data: {
        name: businessName,
        businessId: business.id,
        subscriptionCostGbp: ASSIST_DEFAULTS.subscriptionCostGbp,
        includedMinutes: ASSIST_DEFAULTS.includedMinutes,
        costPerMinuteGbp: ASSIST_DEFAULTS.costPerMinuteGbp,
        vatRate: ASSIST_DEFAULTS.vatRate,
      },
    });

    // 3. AgentConfiguration — defaults to Assist mode. The user can switch
    //    to Automate later via the portal once they've integrated their booking system.
    await prisma.agentConfiguration.create({
      data: {
        garageId: garage.id,
        branchName: businessName,
        branchAddress,
        phoneNumber,
        websiteUrl,
        emailAddress: normalizedEmail,
        ...(weeklyOpeningHours ? { weeklyOpeningHours: weeklyOpeningHours as Prisma.InputJsonValue } : {}),
        greetingLine,
        faqs: seededFaqs as unknown as Prisma.InputJsonValue,
        tonePreference: 'standard',
        responseSpeed: 'normal',
        interruptionSensitivity: 0.5,
        allowFastFitOnly: false,
        integrationProvider: 'none',
        agentType: 'assist',
        // Self-serve sign-ups always go to the Assist worker on the newer
        // LiveKit project (labelled "RMB-Assist" in the portal). Saves the
        // ops team a trip into Agent Configurations -> Routing.
        agentScript: 'Assist-agent',
      },
    });

    // Background: upgrade the seeded FAQs from the garage's website (scrape + AI).
    // Fire-and-forget so signup stays fast; writes straight to Postgres, which the
    // setup wizard reads when the customer reviews their config.
    if (websiteUrl) {
      void (async () => {
        try {
          const aiFaqs = await generateFaqsFromWebsite(websiteUrl!, businessName);
          if (aiFaqs.length >= 3) {
            await prisma.agentConfiguration.update({
              where: { garageId: garage.id },
              data: { faqs: aiFaqs as unknown as Prisma.InputJsonValue },
            });
            console.log(`[PUBLIC_SIGNUP] FAQs upgraded from website for garage=${garage.id} (${aiFaqs.length})`);
          }
        } catch (err) {
          console.error('[PUBLIC_SIGNUP] background FAQ generation failed:', err);
        }
        // Also ingest the website into the knowledge base so the agent can answer from it via RAG
        // (separate from the distilled FAQs above). Best-effort, fire-and-forget.
        await autoIngestWebsiteKnowledge(garage.id, websiteUrl!);
      })();
    }

    // 3a. Grant RECEPTIONMATE_STAFF access so the team can see the new garage
    //     in their admin views — same call the admin quick-onboard makes.
    await ensureAdminAccessToGarage(garage.id).catch((err) =>
      console.error('[PUBLIC_SIGNUP] ensureAdminAccessToGarage failed:', err),
    );

    // 3b. NOTE: Twilio number purchase + SIP provisioning used to live here.
    //     They've been moved to the Stripe webhook handler so we only spend
    //     money on a number after the customer has actually paid for their
    //     first month. See `routes/webhooks/stripe.ts`.

    // 4. User account. Password is the well-known temp value; `mustChangePassword`
    //    forces them to change it on first login. The welcome email that reveals
    //    this password is held back until the user has signed their agreement.
    const passwordHash = await bcrypt.hash(PUBLIC_SIGNUP_TEMP_PASSWORD, 10);
    const user = await prisma.user.create({
      data: {
        email: normalizedEmail,
        passwordHash,
        mustChangePassword: true,
        mustSetupPayment: true,
        garageAccessIds: [garage.id],
        role: 'MANAGER',
        branchRoles: { [garage.id]: 'MANAGER' },
      },
    });

    // 4a. Draft service agreement on Assist defaults. The user signs it via
    //     the magic-link below — only after signing do they get login details.
    //     Assist is instant-live so we set goLiveDate to today; Automate /
    //     Connect signups (when we wire those) will use null until scoped.
    const agreement = await prisma.agreement.create({
      data: {
        type: 'saas',
        version: TEMPLATE_VERSION,
        status: 'sent',
        userId: user.id,
        businessId: business.id,
        clientName: businessName,
        setupFeeGbp: 0,
        licenceFeeGbp: ASSIST_DEFAULTS.subscriptionCostGbp,
        centresCount: 1,
        licences: ['assist'],
        goLiveDate: new Date(),
        templateSnapshot: '',
      },
    });

    // 4b. Magic-link sign token — single-use, expires in 14 days.
    const token = randomBytes(32).toString('base64url');
    await prisma.signLinkToken.create({
      data: {
        token,
        userId: user.id,
        agreementId: agreement.id,
        purpose: 'sign_agreement',
        expiresAt: new Date(Date.now() + SIGN_LINK_TTL_MS),
      },
    });
    const signUrl = `${PORTAL_URL}/agreement/sign?token=${encodeURIComponent(token)}`;

    // 5. Send the "Review and sign" email. The welcome email (with login
    //    details) is sent later, from the agreement-sign endpoint, once the
    //    customer has actually signed.
    // Backup email — only matters if the user closes the tab before signing.
    // The marketing site redirects them straight to the sign page so the
    // common path doesn't touch their inbox at all.
    const subject = 'Finish setting up your ReceptionMate account';
    const html = `
      <div style="font-family:Inter,system-ui,sans-serif;max-width:560px;margin:0 auto;color:#0f172a;">
        <h2 style="color:#3426cf;margin:0 0 12px;">Welcome to ReceptionMate</h2>
        <p>Hi ${escapeForEmail(businessName)},</p>
        <p>Thanks for signing up. If you closed the tab before finishing, you can review and sign your service agreement using the button below — once signed, we'll email your portal login details straight away.</p>
        <p style="text-align:center;margin:28px 0;">
          <a href="${signUrl}" style="display:inline-block;background:#3426cf;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;">Review and sign</a>
        </p>
        <p style="color:#94a3b8;font-size:13px;">This link is valid for 14 days. If you have any questions, just reply to this email.</p>
        <p style="margin-top:32px;color:#64748b;font-size:13px;">— The ReceptionMate team</p>
      </div>
    `;
    const text = `Welcome to ReceptionMate!\n\nIf you closed the tab before finishing, you can review and sign your service agreement here:\n${signUrl}\n\nOnce signed, we'll email your portal login details straight away.\n\nThis link is valid for 14 days.\n\n— The ReceptionMate team`;

    await sendEmail({ to: [normalizedEmail], subject, html, text }).catch((error) => {
      console.error('[PUBLIC_SIGNUP] sign-agreement email failed:', error);
    });

    // 6. HighLevel push — contact + opportunity in the "Free trial live" stage of
    //    the "Onboarding Newest" pipeline. Store the opportunity id so the Stripe
    //    webhook can promote it to "Live and £££" when the 14-day trial converts.
    void pushSignupToHighlevel({
      name: name || businessName,
      email: normalizedEmail,
      phone: phoneNumber ?? undefined,
      companyName: businessName,
      website: websiteUrl ?? undefined,
      source: 'website-getstarted-assist',
      tags: ['website-signup', 'assist', 'trial'],
      opportunityName: `${businessName} — Assist 14-day trial (£${ASSIST_DEFAULTS.subscriptionCostGbp}/mo per branch)`,
      monetaryValueGbp: ASSIST_DEFAULTS.subscriptionCostGbp,
      kind: 'trial',
    }).then((r) => {
      if (r.opportunityId) {
        prisma.garage
          .update({ where: { id: garage.id }, data: { ghlOpportunityId: r.opportunityId } })
          .catch((e) => console.error('[PUBLIC_SIGNUP] failed to store ghlOpportunityId:', e));
      }
    });

    console.log(`[PUBLIC_SIGNUP] created account: ${normalizedEmail} → ${businessName} (garage=${garage.id}, agreement=${agreement.id})`);

    return res.status(201).json({
      success: true,
      // The marketing site redirects the user straight to this URL so they
      // sign in-browser. The email above is a backup if they close the tab.
      signUrl,
      businessName,
    });
  } catch (error) {
    console.error('[PUBLIC_SIGNUP] failed:', error);
    return res.status(500).json({
      success: false,
      error: 'server_error',
      message: 'Something went wrong creating your account. Email hello@receptionmate.co.uk and we\'ll sort it.',
    });
  }
});

export default router;
