// Putting a free-of-charge partner into the CRM.
//
// Some garages run on ReceptionMate without paying: JLK Vehicle Solutions and Woodyard Garage
// (27 Oct) are live in exchange for social-media content. Nothing in the product described that
// before — a quick onboard creates no HighLevel opportunity at all, so both were live, invisible
// to the pipeline, and indistinguishable from a garage that had simply never been billed.
//
// They do not belong in "Free trial live" (nothing expires and nothing converts on a date) or in
// "Live and £££" (they pay nothing, and counting them there overstates revenue by the value of
// the deal). They get their own stage, a tag that says what they are, and a note saying what we
// get back — which is the part that is otherwise only in somebody's head.

import { prisma } from '../db.js';
import {
  highlevelConfigured,
  upsertContact,
  addContactTags,
  addContactNote,
  createOpportunity,
  focStageId,
  HL_FOC_STAGE_NAME,
} from './highlevel.js';
import { DID, FROM, mergeTags } from './highlevelTags.js';

export interface FocPartnerArgs {
  garageId: string;
  /** What we get back — "social media videos". Goes on the opportunity note. */
  inReturnFor: string;
  /** Overrides, when the garage record does not carry the right person. */
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
}

export interface FocPartnerResult {
  ok: boolean;
  reason?: string;
  contactId?: string | null;
  opportunityId?: string | null;
  stageResolved?: boolean;
}

/**
 * Create (or advance) the HighLevel opportunity for a garage we are not charging.
 *
 * Idempotent through createOpportunity, which upserts and only ever moves a contact forward, so
 * running this twice on the same garage does not produce a second card.
 */
export async function markGarageAsFocPartner(args: FocPartnerArgs): Promise<FocPartnerResult> {
  if (!highlevelConfigured()) return { ok: false, reason: 'highlevel_not_configured' };

  const garage = await prisma.garage.findUnique({
    where: { id: args.garageId },
    select: {
      id: true,
      name: true,
      businessId: true,
      subscriptionCostGbp: true,
      ghlOpportunityId: true,
      agentConfiguration: { select: { phoneNumber: true, websiteUrl: true } },
    },
  });
  if (!garage) return { ok: false, reason: 'garage_not_found' };

  const business = garage.businessId
    ? await prisma.business.findUnique({
        where: { id: garage.businessId },
        select: { name: true, contactName: true, contactEmail: true, contactPhone: true },
      })
    : null;

  // The person, not the business: a pipeline card nobody can ring is half a record. Fall back
  // through the garage's own contact details before giving up.
  const email = args.contactEmail || business?.contactEmail || undefined;
  const phone = args.contactPhone || business?.contactPhone || garage.agentConfiguration?.phoneNumber || undefined;
  if (!email && !phone) return { ok: false, reason: 'no_email_or_phone_for_contact' };

  const name = args.contactName || business?.contactName || business?.name || garage.name;
  const tags = mergeTags([FROM.website], [DID.focLive]);

  const { contactId } = await upsertContact({
    name,
    email,
    phone,
    companyName: business?.name || garage.name,
    website: garage.agentConfiguration?.websiteUrl ?? undefined,
    source: 'FOC partner',
    tags,
  });
  if (!contactId) return { ok: false, reason: 'contact_not_created' };
  await addContactTags(contactId, tags);

  const stage = await focStageId();
  const { id: opportunityId } = await createOpportunity({
    contactId,
    // £0 on purpose. The deal is worth something, but not revenue, and a pipeline that totals
    // its own barter deals as income is worse than one that shows them at nothing.
    name: `${business?.name || garage.name} — live, FOC`,
    monetaryValueGbp: 0,
    kind: 'foc',
  });

  await addContactNote(
    contactId,
    [
      `Live on ReceptionMate free of charge, in exchange for: ${args.inReturnFor}.`,
      `Branch: ${garage.name}.`,
      garage.subscriptionCostGbp != null ? `Subscription on the account: £${garage.subscriptionCostGbp}/month.` : '',
      '',
      'Not a trial — there is no end date and nothing converts on its own.',
    ]
      .filter(Boolean)
      .join('\n'),
  );

  if (opportunityId && !garage.ghlOpportunityId) {
    await prisma.garage
      .update({ where: { id: garage.id }, data: { ghlOpportunityId: opportunityId } })
      .catch((e) => console.error('[FOC] could not store the opportunity id:', e));
  }

  console.log(
    `[FOC] ${garage.name} → contact ${contactId}, opportunity ${opportunityId ?? 'none'}` +
      (stage ? '' : ` (stage "${HL_FOC_STAGE_NAME}" does not exist yet — parked in Free trial live)`),
  );
  return { ok: true, contactId, opportunityId, stageResolved: Boolean(stage) };
}
