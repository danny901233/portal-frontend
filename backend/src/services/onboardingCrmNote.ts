import { prisma } from '../db.js';
import { addContactNote, findContactByPhone, highlevelConfigured } from './highlevel.js';

/**
 * A HighLevel timeline note each time an ONBOARDING email goes out.
 *
 * HighLevel is the sales pipeline and owns a garage until it goes live; the portal is the CRM
 * from then on, because the portal holds the calls, bookings, billing and tickets and HighLevel
 * cannot hold any of it. setOnboardingStage already mirrors the STAGE across, but not what was
 * actually said to the garage — so "have they been sent the setup steps yet?" is unanswerable
 * from the place sales actually look.
 *
 * The allow-list IS the feature. Noting every email from the chokepoint would push call
 * summaries, arrears warnings and ticket replies into the timeline, hundreds a day on a live
 * estate, and bury the six that describe an onboarding. Anything not named below is ignored,
 * and an untagged email ("unknown", which is most of EmailLog's history) is ignored too: a
 * wrong note is worse than no note.
 *
 * Everything here is best-effort and never throws. An email the customer is waiting on must
 * never fail, or be held up, because a CRM was slow — the same rule the HighLevel calls in
 * setOnboardingStage already follow.
 */

/** template -> what to call it in the note. Deliberately short and in sales' language. */
export const ONBOARDING_EMAIL_NOTES: Record<string, string> = {
  'agreement-sent': 'Service agreement sent for signature',
  'agreement-signed': 'Service agreement signed',
  'gh-connect-request': 'Garage Hive asked to connect the diary',
  'gh-getting-ready': 'Garage sent their Garage Hive setup steps',
};

// Not listed, on purpose: the portal welcome and the Direct Debit mandate emails. A key here
// with no sender tagging itself is a silent no-op that READS as implemented — the same shape as
// the zod strips and ungated fields this codebase keeps finding. Add the key and the tag in the
// same change, or not at all.

export function isOnboardingEmail(template: string | null | undefined): boolean {
  // hasOwnProperty.call rather than Object.hasOwn: this project's lib target predates it.
  return Boolean(template
    && Object.prototype.hasOwnProperty.call(ONBOARDING_EMAIL_NOTES, template));
}

/** Is there anyone to attach a note to? The agreement emails are BUSINESS level — for a group
 *  there is no single garage they belong to — so either route counts. */
export function hasCrmSubject(args: {
  garageId?: string | null;
  businessId?: string | null;
}): boolean {
  return Boolean(args.garageId || args.businessId);
}

export function buildOnboardingNote(args: {
  template: string;
  subject: string;
  to: string[];
}): string | null {
  const label = ONBOARDING_EMAIL_NOTES[args.template];
  if (!label) return null;
  const recipients = args.to.filter(Boolean).join(', ');
  // Subject on its own line only when there is one — an empty one left a gap and a pair of
  // dangling quotes in the timeline.
  const subjectLine = args.subject.trim() ? `\nSubject: ${args.subject.trim()}` : '';
  return `ReceptionMate onboarding — ${label}.\nSent to: ${recipients}${subjectLine}`;
}

/**
 * The HighLevel contact for a garage, cached on the row once resolved.
 *
 * Garage carries ghlOpportunityId but NOT a contact id — that only ever existed on
 * PendingSignup, and was not carried across when the garage was created. HighLevel notes attach
 * to a contact, so without this there is nothing to write to. Resolved from the business's
 * contact phone and then stored, so it is one lookup per garage rather than one per email.
 *
 * findContactByPhone matches exactly and nothing else, on purpose: its own comment records that
 * a loose match "would hand us a stranger's record to tag and write a call note onto". A miss
 * returns null and the note is simply skipped.
 */
export async function resolveContactId(args: {
  garageId?: string | null;
  businessId?: string | null;
}): Promise<string | null> {
  if (args.garageId) {
    const garage = await prisma.garage.findUnique({
      where: { id: args.garageId },
      select: { ghlContactId: true, businessId: true, business: { select: { contactPhone: true } } },
    });
    if (garage?.ghlContactId) return garage.ghlContactId;
    const phone = (garage?.business?.contactPhone || '').trim();
    if (!phone) return null;
    const contactId = await findContactByPhone(phone);
    if (contactId) {
      await prisma.garage.update({
        where: { id: args.garageId },
        data: { ghlContactId: contactId },
      });
    }
    return contactId;
  }

  if (args.businessId) {
    // Business level. Cache it on any one of the business's garages so the next garage-level
    // email on the same account skips the lookup — the contact is per business, not per branch.
    const business = await prisma.business.findUnique({
      where: { id: args.businessId },
      select: {
        contactPhone: true,
        garages: {
          where: { archivedAt: null },
          select: { id: true, ghlContactId: true },
          orderBy: { name: 'asc' },
        },
      },
    });
    const cached = business?.garages.find((g) => g.ghlContactId)?.ghlContactId;
    if (cached) return cached;
    const phone = (business?.contactPhone || '').trim();
    if (!phone) return null;
    const contactId = await findContactByPhone(phone);
    const target = business?.garages[0]?.id;
    if (contactId && target) {
      await prisma.garage.update({ where: { id: target }, data: { ghlContactId: contactId } });
    }
    return contactId;
  }

  return null;
}

/**
 * Called from the email chokepoint after a send is recorded. Fire-and-forget by design.
 *
 * Returns a boolean for the tests' benefit; no caller waits on it.
 */
export async function noteOnboardingEmail(options: {
  template?: string | null;
  subject: string;
  to: string[];
  garageId?: string | null;
  businessId?: string | null;
}): Promise<boolean> {
  try {
    if (!isOnboardingEmail(options.template) || !hasCrmSubject(options)) return false;
    if (!highlevelConfigured()) return false;

    const body = buildOnboardingNote({
      template: options.template as string,
      subject: options.subject,
      to: options.to,
    });
    if (!body) return false;

    const contactId = await resolveContactId(options);
    if (!contactId) {
      // Logged, not raised. Plenty of garages predate any HighLevel contact, and a garage we
      // cannot match must not turn into noise on every onboarding email it receives.
      console.log(
        '[HL-NOTE] no HighLevel contact for'
          + ` garage=${options.garageId ?? '-'} business=${options.businessId ?? '-'}`
          + ` — skipping note for ${options.template}`,
      );
      return false;
    }
    return await addContactNote(contactId, body);
  } catch (error) {
    console.error('[HL-NOTE] failed to note onboarding email:', error);
    return false;
  }
}
