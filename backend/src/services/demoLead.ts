// A demo call is a lead. This puts it in HighLevel.
//
// ── Why ──────────────────────────────────────────────────────────────────────────────────────
// 66 people talked to the shared demo agent in the last 30 days — 29 on the phone, 37 in the
// browser — and not one of them appeared in the CRM. Adrian (+44 7989 582725, 27 Oct) rang the
// demo line three times in two minutes, got as far as asking about a touch-up job, and existed
// nowhere afterwards except a Call row: no contact, no opportunity, nothing to follow up. The
// only demos that reached HighLevel were the personalised prospect ones in routes/calls.ts,
// because those came OUT of the CRM and already had a contact id.
//
// Someone who dials a number off our homepage and talks to a receptionist for half a minute is
// warmer than most form fills, so they go in at the same "Hot" stage as a prospect who tried
// their own agent. Someone who rang and hung up after fifteen seconds goes in at the enquiry
// stage instead, tagged so they can be told apart — still a real person who dialled us, but not
// someone who has heard anything work.
//
// ── What identifies them ─────────────────────────────────────────────────────────────────────
// HighLevel needs an email or a phone. A phone demo brings the caller's number. A browser demo
// brings nothing at all unless the visitor passed the hero gate that collects name and email, in
// which case the lead id rides in on the room name (see livekit-demo.ts) and we use that contact.
// An anonymous browser demo has no identifier and cannot become a contact: it is counted in the
// log and skipped, because inventing a placeholder contact for every visitor would fill the
// pipeline with rows nobody can ring.
//
// Everything here is best-effort and fire-and-forget. A CRM hiccup must never cost us the call
// record it describes.

import { prisma } from '../db.js';
import {
  highlevelConfigured,
  upsertContact,
  addContactTags,
  addContactNote,
  createOpportunity,
  findContactByPhone,
} from './highlevel.js';
import { DID, FROM } from './highlevelTags.js';

const PORTAL_URL = process.env.PORTAL_URL || 'https://portal.receptionmate.co.uk';

/** How the demo was reached. */
export type DemoVia = 'phone' | 'web';

export interface DemoLeadFacts {
  via: DemoVia;
  /** E.164, from the SIP leg. Null for a browser demo. */
  callerPhone?: string | null;
  /** The marketing-site lead this browser demo belongs to, when the hero gate captured one. */
  lead?: { name: string | null; email: string | null; businessName: string | null; contactId?: string | null } | null;
  /** The name the agent heard, if the caller gave one. */
  heardName?: string | null;
  durationSeconds: number;
  summary?: string | null;
  registrationNumber?: string | null;
  bookingDetails?: string | null;
  confirmedBooking?: boolean;
  /** Our own call id, so the note can link to the recording and transcript. */
  callId?: string | null;
}

/**
 * Numbers that are US, not a lead.
 *
 * We ring the demo line ourselves constantly — Dan's mobile is in the Call table against it more
 * often than any prospect — and every one of those would otherwise become a HighLevel contact and
 * an opportunity in the Hot stage. The ops alert numbers are already configured and are by
 * definition our own phones, so they seed the list for free; DEMO_LEAD_IGNORE_NUMBERS adds any
 * others (comma-separated, any format).
 */
function ourOwnNumbers(): string[] {
  return [
    process.env.DEMO_LEAD_IGNORE_NUMBERS,
    process.env.OPS_ALERT_SMS_TO,
    process.env.LEAD_ALERT_SMS_TO,
  ]
    .filter(Boolean)
    .flatMap((raw) => String(raw).split(','));
}

/** Enough trailing digits to match across dialling prefixes, as callerNumber.ts does. */
const tail9 = (raw: string | null | undefined): string => {
  const digits = (raw ?? '').replace(/\D/g, '');
  return digits.length >= 9 ? digits.slice(-9) : digits;
};

export function isOurOwnNumber(phone: string | null | undefined, list: string[] = ourOwnNumbers()): boolean {
  const caller = tail9(phone);
  if (!caller) return false;
  return list.map(tail9).filter(Boolean).includes(caller);
}

/** +447989582725 → 07989 582725. Display only — HighLevel is given the E.164 form. */
export function displayUkPhone(raw: string | null | undefined): string {
  const s = (raw ?? '').trim();
  if (!s) return '';
  const national = s.startsWith('+44') ? `0${s.slice(3)}` : s.startsWith('44') && s.length > 11 ? `0${s.slice(2)}` : s;
  const digits = national.replace(/\D/g, '');
  // 07989 582725 / 01708 985485 — the five-then-six split UK mobiles and most geographic numbers
  // share. Anything else is left exactly as it came in rather than being mangled into a shape it
  // does not have.
  if (digits.length === 11 && digits.startsWith('0')) return `${digits.slice(0, 5)} ${digits.slice(5)}`;
  return national;
}

/**
 * What to call the contact.
 *
 * The name the agent heard wins, because it is what the person called themselves. Failing that a
 * browser demo has the name from the hero gate. An anonymous caller is named after their number:
 * "Demo caller 07989 582725" sorts together in HL and can still be searched by digits, which a
 * row called "Unknown" cannot.
 */
export function demoContactName(facts: Pick<DemoLeadFacts, 'heardName' | 'lead' | 'callerPhone'>): string {
  const heard = facts.heardName?.trim();
  if (heard) return heard;
  const fromLead = facts.lead?.name?.trim() || facts.lead?.businessName?.trim();
  if (fromLead) return fromLead;
  const phone = displayUkPhone(facts.callerPhone);
  return phone ? `Demo caller ${phone}` : 'Demo caller';
}

/** The opportunity name: the board should say what they did without anyone opening the card. */
export function demoOpportunityName(name: string, via: DemoVia, engaged: boolean): string {
  if (!engaged) return `${name} — rang the demo line, hung up`;
  return via === 'phone' ? `${name} — tried the demo (phone)` : `${name} — tried the demo (web)`;
}

/** Origin + action tags for a demo touch. */
export function demoLeadTags(via: DemoVia, engaged: boolean): string[] {
  return [via === 'phone' ? FROM.demoLine : FROM.webDemo, engaged ? DID.demo : DID.demoDropped];
}

const duration = (seconds: number): string => {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m ? `${m}m ${s}s` : `${s}s`;
};

/**
 * The note that makes the lead workable.
 *
 * A stage change says someone is interested; this says what they asked for, so whoever rings them
 * back opens with "I see you were asking about a touch-up" rather than "I see you clicked
 * something". Same reasoning as the prospect note in routes/calls.ts, which this mirrors.
 */
export function demoCallNote(facts: DemoLeadFacts): string {
  const where = facts.via === 'phone' ? 'Rang the demo line' : 'Tried the demo in the browser';
  const lines = [`${where} — the call lasted ${duration(facts.durationSeconds)}.`];
  if (facts.confirmedBooking) lines.push(`BOOKED: ${facts.bookingDetails || 'a job, details not captured'}`);
  if (facts.heardName) lines.push(`Gave the name: ${facts.heardName}`);
  if (facts.callerPhone) lines.push(`Called from: ${displayUkPhone(facts.callerPhone)}`);
  if (facts.registrationNumber) lines.push(`Registration: ${facts.registrationNumber}`);
  if (facts.summary) lines.push('', facts.summary);
  if (facts.callId) lines.push('', `Recording and transcript: ${PORTAL_URL}/calls/${facts.callId}`);
  return lines.join('\n');
}

/** The note for a call that ended before the agent got anywhere — no transcript worth quoting. */
export function droppedCallNote(callerPhone: string | null | undefined, seconds: number): string {
  return [
    `Rang the demo line and hung up after ${duration(seconds)} — too short to log as a call.`,
    ...(callerPhone ? [`Called from: ${displayUkPhone(callerPhone)}`] : []),
    '',
    'Worth a ring back: they dialled the number off the website themselves.',
  ].join('\n');
}

/**
 * Put a demo call into HighLevel: contact, tags, opportunity, note.
 *
 * `engaged` is what separates the two stages — true for a call that got logged (the agent spoke
 * to them), false for one that was dropped before it started.
 */
async function pushDemoLead(
  facts: DemoLeadFacts,
  opts: { engaged: boolean; note: string | null },
): Promise<void> {
  if (!highlevelConfigured()) return;

  const name = demoContactName(facts);
  const tags = demoLeadTags(facts.via, opts.engaged);
  const email = facts.lead?.email ?? undefined;
  const phone = facts.callerPhone ?? undefined;

  if (isOurOwnNumber(phone)) {
    console.log(`[DEMO_LEAD] skipped: ${displayUkPhone(phone)} is one of ours, not a lead`);
    return;
  }

  if (!email && !phone) {
    // An anonymous browser demo. Nothing to identify them by, so there is no contact to make —
    // logged loudly because the fix is a name-and-email gate in front of the demo, not here.
    console.log('[DEMO_LEAD] skipped: a web demo with no lead id and no phone — nobody to create');
    return;
  }

  // Prefer a contact we already know over creating one: the lead id the CTA left us, else a match
  // on the caller's number. Tagging an existing contact leaves its `source` — and so where that
  // garage first came from — intact, which an upsert would overwrite.
  let contactId = facts.lead?.contactId ?? (phone ? await findContactByPhone(phone) : null);
  if (contactId) {
    await addContactTags(contactId, tags);
  } else {
    // Only the from-/did- tags. 'website-lead' is deliberately NOT added: somebody who dialled a
    // number has not touched the website, and that mislabelling is half of what this work is
    // fixing.
    const contact = await upsertContact({
      name,
      email,
      phone,
      companyName: facts.lead?.businessName ?? undefined,
      source: facts.via === 'phone' ? 'demo line' : 'web demo',
      tags,
    });
    contactId = contact.contactId;
  }
  if (!contactId) {
    console.error('[DEMO_LEAD] no contact id came back — opportunity skipped');
    return;
  }

  // createOpportunity is an upsert that only ever moves a contact FORWARD, so a garage already on
  // a trial who rings the demo line again cannot be dragged back to Hot, and three calls in two
  // minutes produce one opportunity rather than three.
  //
  // No monetary value: we do not know what package an unknown caller would buy, and £200 against
  // every curious caller would quietly inflate the pipeline.
  const { id } = await createOpportunity({
    contactId,
    name: demoOpportunityName(name, facts.via, opts.engaged),
    kind: opts.engaged ? 'hot' : 'lead',
  });
  console.log(
    `[DEMO_LEAD] ${name} (${facts.via}${opts.engaged ? '' : ', dropped'}) → contact ${contactId}, ` +
      `opportunity ${id ?? 'not created'}`,
  );

  if (opts.note) await addContactNote(contactId, opts.note);
}

/** A demo call that was logged: the agent talked to them. */
export async function captureDemoCallLead(facts: DemoLeadFacts): Promise<void> {
  try {
    await pushDemoLead(facts, { engaged: true, note: demoCallNote(facts) });
  } catch (err) {
    console.error('[DEMO_LEAD] demo call push failed:', err);
  }
}

/**
 * A demo call too short to be logged as one.
 *
 * Twilio's recording-status callback is the only thing that sees these — the room empties before
 * the agent's shutdown runs — so this hangs off the same short-call path that decides about
 * callbacks. The note is written only for the caller's first attempt of the day: Adrian's two
 * 15-second drops would otherwise have left two identical notes on the same record.
 */
export async function captureDroppedDemoCallLead(args: {
  callerPhone: string | null;
  durationSeconds: number;
  firstAttemptToday: boolean;
}): Promise<void> {
  if (!args.callerPhone) return;
  try {
    await pushDemoLead(
      { via: 'phone', callerPhone: args.callerPhone, durationSeconds: args.durationSeconds },
      {
        engaged: false,
        note: args.firstAttemptToday ? droppedCallNote(args.callerPhone, args.durationSeconds) : null,
      },
    );
  } catch (err) {
    console.error('[DEMO_LEAD] dropped demo call push failed:', err);
  }
}

/**
 * The marketing-site lead a browser demo belongs to.
 *
 * The room name carries `_lead-<PendingSignup id>` when the visitor came through a CTA that
 * collected their details. The id is only ever one we minted and validated at token time, so
 * nothing caller-supplied reaches the room name — the same rule the prospect slug follows.
 */
export function leadIdFromRoomName(roomName: string | null | undefined): string | null {
  const m = (roomName ?? '').match(/_lead-([A-Za-z0-9-]{10,40})(?:_|$)/);
  return m ? m[1] : null;
}

export async function leadForRoom(roomName: string | null | undefined): Promise<DemoLeadFacts['lead']> {
  const id = leadIdFromRoomName(roomName);
  if (!id) return null;
  try {
    const row = await prisma.pendingSignup.findUnique({
      where: { id },
      select: { name: true, email: true, businessName: true, ghlContactId: true },
    });
    if (!row) return null;
    return {
      name: row.name,
      email: row.email,
      businessName: row.businessName,
      contactId: row.ghlContactId,
    };
  } catch (err) {
    console.error('[DEMO_LEAD] lead lookup failed:', err);
    return null;
  }
}
