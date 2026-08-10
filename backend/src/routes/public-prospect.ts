// Progressive-capture prospect endpoints for the marketing get-started funnel.
//   POST  /public/prospect       — step 1 (garage chosen): create a PendingSignup + a
//                                   HighLevel opportunity in "Abandoned checkout".
//   PATCH /public/prospect/:id    — step 2 (contact details): enrich the contact + prospect.
// No account is created here — that only happens after sign + card (see webhooks/stripe.ts).

import type { Request, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { prisma } from '../db.js';
import { fetchPlaceDetails } from '../utils/googlePlaces.js';
import { highlevelConfigured, upsertContact, updateContact, createOpportunity } from '../services/highlevel.js';
import type { Prisma } from '@prisma/client';

const router = Router();

const SIGN_LINK_TTL_MS = 14 * 24 * 60 * 60 * 1000;

const createSchema = z.object({
  businessName: z.string().trim().min(2).max(200),
  googlePlaceId: z.string().trim().max(200).optional(),
  address: z.string().trim().max(500).optional(),
});

const enrichSchema = z.object({
  name: z.string().trim().max(120).optional(),
  email: z.string().trim().email().max(254).optional(),
  phone: z.string().trim().max(40).optional(),
  product: z.enum(['assist', 'automate', 'connect', 'multibranch', 'custom']).optional(),
});

// Give the opportunity a helpful name as we learn more about the prospect.
function oppName(businessName: string, product?: string | null): string {
  if (!product) return `${businessName} — signup started`;
  const label = product === 'assist' ? 'Assist' : product === 'automate' ? 'Automate'
    : product === 'connect' ? 'Connect' : product === 'multibranch' ? 'Multi-branch' : 'Custom';
  return `${businessName} — ${label}`;
}

// Sync a prospect to HighLevel: always upsert (enrich) the contact; create the abandoned-
// checkout opportunity ONLY if one doesn't exist yet (idempotent — safe to call at every step).
// Best-effort; returns the resolved { opportunityId, contactId }.
async function syncProspectToHl(pending: {
  id: string; businessName: string; name: string | null; email: string | null;
  phoneNumber: string | null; contactPhone: string | null; websiteUrl: string | null; product: string | null;
  ghlOpportunityId: string | null; ghlContactId: string | null;
}): Promise<{ opportunityId: string | null; contactId: string | null }> {
  if (!highlevelConfigured()) {
    return { opportunityId: pending.ghlOpportunityId, contactId: pending.ghlContactId };
  }

  const realPhone = pending.contactPhone || pending.phoneNumber || undefined;
  const realEmail = pending.email || undefined;
  let contactId = pending.ghlContactId;

  if (contactId) {
    // Enrich the EXISTING contact by id (replaces any placeholder) — never creates a duplicate.
    await updateContact(contactId, {
      name: pending.name || pending.businessName,
      email: realEmail,
      phone: realPhone,
      website: pending.websiteUrl ?? undefined,
    });
  } else {
    // First contact for this prospect. HL needs a phone OR email; if we have neither yet (no
    // Google phone, no email until the next step), use a UNIQUE placeholder email so the
    // opportunity is still created from just the business name. It's overwritten on enrich.
    const placeholderEmail = !realEmail && !realPhone ? `prospect-${pending.id}@pending.receptionmate.co.uk` : undefined;
    const contact = await upsertContact({
      name: pending.name || pending.businessName,
      email: realEmail || placeholderEmail,
      phone: realPhone,
      companyName: pending.businessName,
      website: pending.websiteUrl ?? undefined,
      source: 'website-getstarted',
      tags: ['website-signup', 'abandoned-checkout'],
    });
    contactId = contact.contactId;
  }

  let opportunityId = pending.ghlOpportunityId;
  if (!opportunityId && contactId) {
    const opp = await createOpportunity({
      contactId,
      name: oppName(pending.businessName, pending.product),
      kind: 'abandoned',
    });
    opportunityId = opp.id;
  }
  return { opportunityId, contactId };
}

// POST /api/public/prospect — step 1
router.post('/public/prospect', async (req: Request, res: Response) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'invalid_request' });
  const { businessName, googlePlaceId, address } = parsed.data;

  try {
    const place = googlePlaceId ? await fetchPlaceDetails(googlePlaceId) : null;
    const signToken = randomBytes(32).toString('base64url');
    const pending = await prisma.pendingSignup.create({
      data: {
        businessName,
        email: '', // filled at the enrich step
        googlePlaceId: googlePlaceId ?? null,
        branchAddress: place?.address || address || null,
        phoneNumber: place?.phone || null,
        websiteUrl: place?.website || null,
        weeklyOpeningHours: place?.weeklyOpeningHours
          ? (place.weeklyOpeningHours as Prisma.InputJsonValue)
          : undefined,
        signToken,
        status: 'prospect',
        expiresAt: new Date(Date.now() + SIGN_LINK_TTL_MS),
      },
    });

    // Fire the abandoned-checkout opportunity (best-effort; won't block the response).
    void syncProspectToHl(pending)
      .then(({ opportunityId, contactId }) => {
        if (opportunityId || contactId) {
          return prisma.pendingSignup.update({
            where: { id: pending.id },
            data: { ghlOpportunityId: opportunityId, ghlContactId: contactId },
          });
        }
      })
      .catch((e) => console.error('[PROSPECT] HL abandoned opp failed:', e));

    return res.json({ ok: true, prospectId: pending.id, signToken });
  } catch (err) {
    console.error('[PROSPECT] create failed:', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// PATCH /api/public/prospect/:id — step 2 (enrich with contact details)
router.patch('/public/prospect/:id', async (req: Request, res: Response) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const parsed = enrichSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: 'invalid_request' });

  try {
    const pending = await prisma.pendingSignup.findUnique({ where: { id: req.params.id } });
    if (!pending || pending.status === 'completed') {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    const updated = await prisma.pendingSignup.update({
      where: { id: pending.id },
      data: {
        name: parsed.data.name ?? pending.name,
        email: parsed.data.email ? parsed.data.email.toLowerCase() : pending.email,
        contactPhone: parsed.data.phone ?? pending.contactPhone,
        product: parsed.data.product ?? pending.product,
      },
    });

    // Enrich the HL contact + create the opp now if it wasn't made at step 1 (no id then).
    void syncProspectToHl(updated)
      .then(({ opportunityId, contactId }) => {
        if (opportunityId !== updated.ghlOpportunityId || contactId !== updated.ghlContactId) {
          return prisma.pendingSignup.update({
            where: { id: updated.id },
            data: { ghlOpportunityId: opportunityId, ghlContactId: contactId },
          });
        }
      })
      .catch((e) => console.error('[PROSPECT] HL enrich failed:', e));

    return res.json({ ok: true });
  } catch (err) {
    console.error('[PROSPECT] enrich failed:', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

export default router;
