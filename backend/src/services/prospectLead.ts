// A call to a prospect's OWN demo agent is a lead. This puts it in HighLevel.
//
// ── Why this exists ──────────────────────────────────────────────────────────────────────────
// routes/calls.ts raised the Hot opportunity inline, and only when the DemoProspect row already
// carried a HighLevel contact id. An audit on 4 Nov 2026 found three ways a real caller fell
// through that:
//
//   1. The row had no contact at all. Protyre Warwick, Sytner Swansea BMW and Stellantis
//      Nottingham were seeded with no email; each rang their own demo and the push skipped them
//      without a word in the log.
//   2. The /tyresoft page mints the demo row in the same second as the PendingSignup, before the
//      background CRM sync has written `ghlContactId` — so the demo's `contactId` is null for
//      ever, even though the signup gets its contact a moment later (Testwood Lakes, 2 Nov 16:14,
//      both rows one minute apart, only one with a contact).
//   3. A call under the agent's 30-second logging floor creates no Call row, so nothing fires.
//      Thompson Service Centre dialled sixteen times and never once reached the CRM. The shared
//      demo line has a "rang and hung up" path off Twilio's recording callback, but the prospect
//      leg records nothing and so had no callback at all.
//
// So the contact is now resolved AT CALL TIME — the row's own id, else the newest signup for the
// same Google place, else a contact made from the garage's own name, phone and email — and the
// prospect phone leg reports every ended call so a hang-up still lands at the enquiry stage.
//
// Everything here is best-effort and fire-and-forget: a CRM hiccup must never cost us the call
// record it describes, nor delay the agent waiting on the call-log response.

import { prisma } from '../db.js';
import {
  highlevelConfigured,
  upsertContact,
  findContactByPhone,
  addContactTags,
  addContactNote,
  createOpportunity,
} from './highlevel.js';
import type { UpsertContactArgs } from './highlevel.js';
import { DID, FROM } from './highlevelTags.js';
import { displayUkPhone } from './demoLead.js';

const PORTAL_URL = process.env.PORTAL_URL || 'https://portal.receptionmate.co.uk';

/** The agent's logging floor: calls shorter than this never become a Call row. Same as voice.ts. */
export const CALL_LOG_FLOOR_SECONDS = 30;

/** What the resolver needs from a DemoProspect row. */
export type ProspectForLead = {
  id: string;
  slug: string;
  spokenName: string;
  businessName: string;
  email: string | null;
  contactId: string | null;
  placeId: string | null;
  phoneNumber: string | null;
};

export type ProspectCallFacts = {
  slug: string;
  durationSeconds: number;
  summary?: string | null;
  customerName?: string | null;
  registrationNumber?: string | null;
  bookingDetails?: string | null;
  confirmedBooking?: boolean;
};

const duration = (seconds: number): string => {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m ? `${m}m ${s}s` : `${s}s`;
};

/**
 * The contact to make for a prospect that has none.
 *
 * HighLevel needs an email or a phone. The row carries the garage's own Google phone for every
 * prospect with a placeId, and the CRM email where one was known, so one of the two is nearly
 * always there. Null when neither is: a contact nobody can ring or email is not a lead.
 */
export function contactArgsForProspect(
  p: Pick<ProspectForLead, 'spokenName' | 'businessName' | 'email' | 'phoneNumber'>,
): UpsertContactArgs | null {
  const email = p.email?.trim() || undefined;
  const phone = p.phoneNumber?.trim() || undefined;
  if (!email && !phone) return null;
  const name = p.spokenName?.trim() || p.businessName?.trim() || 'Garage';
  return {
    name,
    companyName: p.businessName?.trim() || name,
    email,
    phone,
    source: 'own demo',
  };
}

/** A connected leg that ended under the logging floor: they dialled, heard something, and left. */
export function isDroppedProspectDial(dialStatus: string, durationSeconds: number): boolean {
  if (dialStatus !== 'completed') return false;
  if (!Number.isFinite(durationSeconds)) return false;
  return durationSeconds < CALL_LOG_FLOOR_SECONDS;
}

/** The note that makes the lead workable: what they asked for, and a link back to their demo. */
export function prospectCallNote(f: ProspectCallFacts): string {
  const lines = [`Tried their demo receptionist — call lasted ${duration(f.durationSeconds)}.`];
  if (f.confirmedBooking) lines.push(`BOOKED: ${f.bookingDetails || 'a job, details not captured'}`);
  if (f.customerName) lines.push(`Gave the name: ${f.customerName}`);
  if (f.registrationNumber) lines.push(`Registration: ${f.registrationNumber}`);
  if (f.summary) lines.push('', f.summary);
  lines.push('', `Their demo: ${PORTAL_URL}/try/${f.slug}`);
  return lines.join('\n');
}

export function prospectDroppedNote(f: { slug: string; callerPhone: string | null; durationSeconds: number }): string {
  return [
    `Rang their own demo receptionist and hung up after ${duration(f.durationSeconds)} — too short to log as a call.`,
    ...(f.callerPhone ? [`Called from: ${displayUkPhone(f.callerPhone)}`] : []),
    '',
    'Worth a ring back: they opened their link and dialled it themselves.',
    '',
    `Their demo: ${PORTAL_URL}/try/${f.slug}`,
  ].join('\n');
}

/**
 * The HighLevel contact for this prospect, found or made, and written back to the row so the
 * next call does not look again.
 *
 * Order: the row's own id (the seeded cold prospects came OUT of the CRM with one); else the
 * newest PendingSignup for the same Google place that has synced (this is the /tyresoft race —
 * the signup gets its contact seconds after the demo row was minted without one); else a contact
 * made from the garage's own details, looking the phone up first so an existing record keeps its
 * `source` rather than having it overwritten by an upsert.
 */
export async function resolveProspectContactId(p: ProspectForLead): Promise<string | null> {
  if (p.contactId) return p.contactId;
  if (!highlevelConfigured()) return null;

  let contactId: string | null = null;
  let how = '';

  if (p.placeId) {
    try {
      const signup = await prisma.pendingSignup.findFirst({
        where: { googlePlaceId: p.placeId, ghlContactId: { not: null } },
        orderBy: { createdAt: 'desc' },
        select: { ghlContactId: true },
      });
      if (signup?.ghlContactId) {
        contactId = signup.ghlContactId;
        how = 'from the signup for the same Google place';
      }
    } catch (err) {
      console.error('[PROSPECT_LEAD] signup lookup failed:', err);
    }
  }

  if (!contactId) {
    const args = contactArgsForProspect(p);
    if (!args) {
      console.warn(`[PROSPECT_LEAD] ${p.spokenName} has no contact, no email and no phone — nobody to create`);
      return null;
    }
    if (args.phone) {
      contactId = await findContactByPhone(args.phone);
      if (contactId) how = 'matched by the garage phone';
    }
    if (!contactId) {
      const made = await upsertContact(args);
      contactId = made.contactId;
      how = 'created from the garage details';
    }
  }

  if (!contactId) {
    console.error(`[PROSPECT_LEAD] ${p.spokenName}: no contact id came back — opportunity skipped`);
    return null;
  }

  console.log(`[PROSPECT_LEAD] ${p.spokenName} → contact ${contactId} (${how})`);
  try {
    await prisma.demoProspect.update({ where: { id: p.id }, data: { contactId } });
  } catch (err) {
    // The push below still runs; only the shortcut for next time is lost.
    console.error('[PROSPECT_LEAD] could not store the contact id on the prospect:', err);
  }
  return contactId;
}

/**
 * A logged call to their own agent: Hot opportunity, tags, note.
 *
 * createOpportunity is an upsert that only ever moves a contact FORWARD, so a garage already on a
 * trial who rings their demo line again cannot be dragged back to Hot, and a second call in the
 * same minute reuses the first call's opportunity.
 */
export async function captureProspectCallLead(p: ProspectForLead, facts: ProspectCallFacts): Promise<void> {
  try {
    const contactId = await resolveProspectContactId(p);
    if (!contactId) return;
    // Additive, so the directory-import tags these cold contacts came in with survive.
    await addContactTags(contactId, [FROM.ownDemo, DID.demo]);
    const { id } = await createOpportunity({
      contactId,
      name: p.spokenName,
      kind: 'hot',
      // The Assist monthly, so the pipeline carries a value rather than a blank.
      monetaryValueGbp: 200,
      packageName: 'Assist',
    });
    console.log(`[CALL] ${p.spokenName} → HighLevel opportunity ${id ?? 'not created'} (Hot)`);
    const noted = await addContactNote(contactId, prospectCallNote(facts));
    console.log(`[CALL] ${p.spokenName} → HighLevel note ${noted ? 'added' : 'FAILED'}`);
  } catch (err) {
    console.error('[CALL] could not raise the Hot opportunity or note', err);
  }
}

/**
 * A call to their own agent that ended under the logging floor.
 *
 * Enquiry stage, not Hot: they dialled, but heard nothing work. Tagged did-demo-dropped so the
 * two can be told apart on the board. Forward-only, so a prospect already at Hot from an earlier
 * full call is left where they are and just picks up the note.
 */
export async function captureDroppedProspectCallLead(
  p: ProspectForLead,
  args: { callerPhone: string | null; durationSeconds: number },
): Promise<void> {
  try {
    const contactId = await resolveProspectContactId(p);
    if (!contactId) return;
    await addContactTags(contactId, [FROM.ownDemo, DID.demoDropped]);
    const { id } = await createOpportunity({
      contactId,
      name: `${p.spokenName} — rang their demo, hung up`,
      kind: 'lead',
    });
    console.log(`[CALL] ${p.spokenName} (dropped after ${args.durationSeconds}s) → HighLevel opportunity ${id ?? 'not created'}`);
    await addContactNote(contactId, prospectDroppedNote({ slug: p.slug, ...args }));
  } catch (err) {
    console.error('[CALL] could not record the dropped prospect call', err);
  }
}

/**
 * Whether the agent has logged a call for this prospect in the last few minutes.
 *
 * Twilio's dial duration and the agent's own clock disagree by a second or two around the
 * floor, so a 29-second leg by Twilio can be a 31-second call the agent did log. The Twilio side
 * waits briefly and asks before calling it a hang-up, so one call cannot be both.
 */
export async function prospectCallLoggedRecently(prospectId: string, withinMs = 5 * 60_000): Promise<boolean> {
  try {
    const row = await prisma.call.findFirst({
      where: {
        createdAt: { gte: new Date(Date.now() - withinMs) },
        metrics: { path: ['demoProspect', 'id'], equals: prospectId },
      },
      select: { id: true },
    });
    return Boolean(row);
  } catch (err) {
    console.error('[PROSPECT_LEAD] recent-call lookup failed:', err);
    return false;
  }
}
