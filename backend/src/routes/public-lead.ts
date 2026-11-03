// Public lead-capture endpoint. Marketing site CTAs POST here; we push the
// contact to HighLevel and create an opportunity in the "Onboarding Newest"
// pipeline (Enquiry Received stage) so the team can work it.

import type { Request, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { sendEmail } from '../utils/email.js';
import { sendOpsSms } from '../utils/opsAlerts.js';
import { prisma } from '../db.js';
import { highlevelConfigured, upsertContact, createOpportunity, updateOpportunity, ENQUIRY_STAGE_ID } from '../services/highlevel.js';

const router = Router();

/** Treat "" / "   " as "not provided" — see the note on companyName below. */
const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const leadSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(254),
  // Company and phone are optional because not every CTA asks for them. The "Hear Leah answer a
  // call" button on the homepage collects name and email only — someone who just wants to listen
  // should not be made to hand over a phone number, and the point of that gate is simply to leave
  // a contactable lead rather than an anonymous session. The forms that DO ask for these still
  // enforce them client-side, so the callback flow is unchanged.
  // preprocess: an HTML form always submits its inputs, so a hidden/unused field arrives as ""
  // rather than being absent. .optional() alone allows undefined but still rejects "", so coerce
  // empty strings to undefined before validating.
  companyName: z.preprocess(blankToUndefined, z.string().trim().min(2).max(200).optional()),
  phone: z.preprocess(blankToUndefined, z.string().trim().min(7).max(40).optional()),
  // Optional — lets each CTA tell us where the lead came from.
  source: z.string().trim().max(60).optional(),
  // Free-form notes (e.g. tier interest + GMS used). Surfaced in the team
  // notification email; not pushed to HighLevel as a custom field today.
  notes: z.string().trim().max(500).optional(),
  // When present, moves the prospect's existing Abandoned-checkout opportunity to
  // "Enquiry Received & Demo Links sent" instead of creating a fresh opportunity.
  prospectId: z.string().trim().max(80).optional(),
  // Google Ads click id from the marketing site — see public-signup.ts.
  gclid: z.string().trim().max(200).optional(),
});

const PRIMARY_TAG = process.env.GHL_LEAD_TAG || 'website-lead';
const TEAM_INBOX = 'hello@receptionmate.co.uk';

router.post('/public/lead', async (req: Request, res: Response) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const parsed = leadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: 'Invalid input', issues: parsed.error.flatten() });
  }

  const { name, companyName, email, phone, source, notes, prospectId, gclid } = parsed.data;

  // Always notify the team by email + SMS — gives us a fallback record even
  // if HighLevel is down for any reason.
  void notifyTeam({ name, companyName, email, phone, source, notes });
  void notifyTeamSms({ name, companyName, email, phone, source });

  if (!highlevelConfigured()) {
    console.warn('[LEAD] HighLevel env vars not set — skipping CRM sync.');
    return res.json({ ok: true, syncedToCrm: false });
  }

  // Prospect path: the opportunity already exists in "Abandoned checkout" (created at the
  // garage-search step). Enrich the contact and move the opp to the enquiry stage.
  if (prospectId) {
    try {
      const pending = await prisma.pendingSignup.findUnique({ where: { id: prospectId } });
      if (pending) {
        await upsertContact({ name, email, phone, companyName, source: source || 'website', tags: [PRIMARY_TAG] });
        if (pending.ghlOpportunityId && ENQUIRY_STAGE_ID) {
          await updateOpportunity(pending.ghlOpportunityId, { stageId: ENQUIRY_STAGE_ID });
        }
        await prisma.pendingSignup.update({ where: { id: pending.id }, data: { status: 'enquiry', name, email: email.toLowerCase(), contactPhone: phone, gclid: pending.gclid ?? gclid ?? null } });
        return res.json({ ok: true, syncedToCrm: true, opportunityId: pending.ghlOpportunityId });
      }
    } catch (err) {
      console.error('[LEAD] prospect move failed, falling back to fresh opportunity:', err);
    }
  }

  const contact = await upsertContact({
    name,
    email,
    phone,
    companyName,
    source: source || 'website',
    tags: [PRIMARY_TAG],
  });

  if (!contact.contactId) {
    return res.json({ ok: true, syncedToCrm: false });
  }

  // Best-effort opportunity creation — failure doesn't fail the request.
  const opportunity = await createOpportunity({
    contactId: contact.contactId,
    name: `${companyName || name} — ${humaniseSource(source)}`,
    kind: 'lead',
  });

  return res.json({
    ok: true,
    syncedToCrm: true,
    contactId: contact.contactId,
    opportunityId: opportunity.id,
  });
});

// Turn machine source slugs into a friendlier opportunity-name suffix.
//   website-getstarted-automate-garagehive → "Automate (Garage Hive)"
//   website-getstarted-multibranch         → "Multi-branch enquiry"
function humaniseSource(source?: string): string {
  if (!source) return 'Website enquiry';
  const s = source.toLowerCase();
  if (s.includes('multibranch')) return 'Multi-branch enquiry';
  if (s.includes('automate')) {
    if (s.includes('garagehive')) return 'Automate (Garage Hive)';
    if (s.includes('tyresoft'))   return 'Automate (Tyresoft)';
    return 'Automate enquiry';
  }
  if (s.includes('connect')) {
    if (s.includes('garagehive')) return 'Connect (Garage Hive)';
    if (s.includes('tyresoft'))   return 'Connect (Tyresoft)';
    return 'Connect enquiry';
  }
  if (s.includes('assist')) return 'Assist enquiry';
  if (s.includes('demo')) return 'Book a demo';
  return 'Website enquiry';
}

// Fire a short SMS to the team so a new lead is impossible to miss.
function notifyTeamSms(lead: {
  name: string;
  companyName?: string;
  email: string;
  phone?: string;
  source?: string;
}): void {
  // Company and phone are absent on the name+email CTAs, so build the lines from what we have
  // rather than texting the word "undefined".
  const who = [lead.name, lead.companyName].filter(Boolean).join(', ');
  const contact = [lead.phone, lead.email].filter(Boolean).join(' · ');
  void sendOpsSms(`New RM lead — ${humaniseSource(lead.source)}\n${who}\n${contact}`);
}

async function notifyTeam(lead: {
  name: string;
  companyName?: string;
  email: string;
  phone?: string;
  source?: string;
  notes?: string;
}): Promise<void> {
  try {
    // Company is absent on the name+email CTAs — fall back to the person's name so the subject
    // line never reads "New website lead — undefined".
    const subject = `New website lead — ${lead.companyName || lead.name}`;
    const html = `
      <div style="font-family:Inter,system-ui,sans-serif;max-width:560px;margin:0 auto;color:#0f172a;padding:24px 0;">
        <h2 style="color:#3426cf;margin:0 0 12px;">New website lead</h2>
        <table cellpadding="0" cellspacing="0" style="font-size:14px;border-collapse:collapse;">
          <tr><td style="padding:6px 16px 6px 0;color:#475569;">Name:</td><td style="padding:6px 0;"><strong>${esc(lead.name)}</strong></td></tr>
          ${lead.companyName ? `<tr><td style="padding:6px 16px 6px 0;color:#475569;">Company:</td><td style="padding:6px 0;"><strong>${esc(lead.companyName)}</strong></td></tr>` : ''}
          <tr><td style="padding:6px 16px 6px 0;color:#475569;">Email:</td><td style="padding:6px 0;"><a href="mailto:${esc(lead.email)}">${esc(lead.email)}</a></td></tr>
          ${lead.phone ? `<tr><td style="padding:6px 16px 6px 0;color:#475569;">Phone:</td><td style="padding:6px 0;"><a href="tel:${esc(lead.phone)}">${esc(lead.phone)}</a></td></tr>` : ''}
          ${lead.source ? `<tr><td style="padding:6px 16px 6px 0;color:#475569;">Source:</td><td style="padding:6px 0;">${esc(lead.source)}</td></tr>` : ''}
          ${lead.notes  ? `<tr><td style="padding:6px 16px 6px 0;color:#475569;vertical-align:top;">Notes:</td><td style="padding:6px 0;">${esc(lead.notes)}</td></tr>` : ''}
        </table>
        <p style="margin-top:24px;color:#64748b;font-size:12px;">This contact has also been pushed to HighLevel as an opportunity.</p>
      </div>
    `;
    const text =
      `New website lead\n\nName: ${lead.name}\n${lead.companyName ? `Company: ${lead.companyName}\n` : ''}Email: ${lead.email}\n${lead.phone ? `Phone: ${lead.phone}\n` : ''}${lead.source ? `Source: ${lead.source}\n` : ''}${lead.notes ? `Notes: ${lead.notes}\n` : ''}`;
    await sendEmail({ to: [TEAM_INBOX], subject, html, text });
  } catch (err) {
    console.error('[LEAD] team-notification email failed:', err);
  }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export default router;
