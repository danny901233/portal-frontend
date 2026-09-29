/**
 * Turning phone calls on OUR OWN lines into support tickets.
 *
 * ── Why this is scoped, and scoped tightly ──────────────────────────────────
 * /admin/tickets is ReceptionMate's support queue. A complaint call to Speedy
 * Spanners belongs to Speedy Spanners — it is their customer, their problem, and
 * it must never land in our queue. So nothing here fires unless the garage is
 * named in SUPPORT_TICKET_GARAGE_IDS, and an unset variable means no tickets at
 * all rather than tickets for everyone. Getting that backwards would flood the
 * queue with other people's customers on the first busy morning.
 *
 * Two entry points:
 *   - the AI answered, and the classifier says a human is wanted
 *   - a human answered a screened call, and what was said implies follow-up
 *
 * Both file on the `phone` channel, because that is how you reply: by ringing
 * them back. Nothing is emailed to the caller — we usually only have a number,
 * and a cold "we've raised a ticket" text to someone who rang five minutes ago
 * is worse than a call back.
 */
import OpenAI from 'openai';
import { TicketChannel, TicketCategory, TicketEntryKind, TicketPriority } from '@prisma/client';
import { prisma } from '../db.js';
import { notifyReceptionMateStaff } from '../utils/push.js';

let client: OpenAI | null = null;
const oa = () => (client ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY }));

/** Garages whose calls are OURS to answer. Empty = feature off. */
export function ticketRaisingGarages(): Set<string> {
  return new Set(
    (process.env.SUPPORT_TICKET_GARAGE_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export const raisesTickets = (garageId: string | null | undefined): boolean =>
  !!garageId && ticketRaisingGarages().has(garageId);

interface CreateArgs {
  garageId: string;
  garageName: string;
  callerPhone?: string | null;
  callerName?: string | null;
  title: string;
  body: string;
  priority?: TicketPriority;
  category?: TicketCategory;
}

async function createCallTicket(args: CreateArgs): Promise<void> {
  const phone = args.callerPhone?.trim() || null;

  // A Contact needs an email or a phone. Withheld numbers give us neither, so
  // the ticket is still worth raising but cannot be tied to anyone — a synthetic
  // key keeps it from colliding with a real contact.
  // Only `email` is unique on Contact, so a phone lookup is find-then-create
  // rather than an upsert. Two calls from the same number in the same instant
  // could make a duplicate contact; that is a tidier problem than a failed
  // ticket, and the tickets still both exist.
  let contact = phone ? await prisma.contact.findFirst({ where: { phone } }) : null;
  if (!contact) {
    contact = await prisma.contact.create({
      data: {
        phone: phone ?? undefined,
        name: args.callerName ?? (phone ? undefined : 'Withheld number'),
        garageId: args.garageId,
      },
    });
  } else if (args.callerName && !contact.name) {
    contact = await prisma.contact.update({
      where: { id: contact.id },
      data: { name: args.callerName },
    });
  }

  const ticket = await prisma.ticket.create({
    data: {
      title: args.title.slice(0, 300),
      channel: TicketChannel.phone,
      category: args.category ?? TicketCategory.other,
      priority: args.priority ?? TicketPriority.normal,
      // Same reason as feedback: they rang us, they did not write to us. The
      // phone channel already refuses to send, but say it explicitly so the
      // intent survives anyone changing that.
      autoChase: false,
      contactId: contact.id,
      garageId: args.garageId,
      entries: {
        create: {
          kind: TicketEntryKind.public_reply,
          authorContactId: contact.id,
          body: args.body,
        },
      },
    },
  });

  void notifyReceptionMateStaff({
    title: 'Call needs follow-up',
    subtitle: phone || args.garageName,
    body: args.title,
    data: { type: 'ticket', ticketId: ticket.id, ticketNumber: ticket.number },
  }).catch((err) => console.error('[CALL_TICKET] push failed:', err));

  console.log(`[CALL_TICKET] ticket #${ticket.number} raised for ${args.garageName} (${phone || 'withheld'})`);
}

// ── 1. The AI answered ──────────────────────────────────────────────────────

/** Call categories that mean a person is wanted. Deliberately short: a booking
 *  the agent completed is a job done, not a ticket, and a queue full of "took a
 *  booking" is a queue nobody reads. */
const CATEGORIES_NEEDING_A_HUMAN = new Set(['complaint', 'human request']);

export async function raiseTicketFromAiCall(args: {
  garageId: string;
  garageName: string;
  callId: string;
  callType?: string | null;
  summary?: string | null;
  customerPhone?: string | null;
  customerName?: string | null;
}): Promise<void> {
  try {
    if (!raisesTickets(args.garageId)) return;
    const type = (args.callType || '').toLowerCase();
    if (!CATEGORIES_NEEDING_A_HUMAN.has(type)) return;

    const base = (process.env.PORTAL_BASE_URL || 'https://portal.receptionmate.co.uk').replace(/\/$/, '');
    await createCallTicket({
      garageId: args.garageId,
      garageName: args.garageName,
      callerPhone: args.customerPhone,
      callerName: args.customerName,
      title: `${type === 'complaint' ? 'Complaint' : 'Caller asked for a person'} — ${args.customerPhone || 'withheld number'}`,
      body: [
        `The agent handled this call and classified it as "${type}".`,
        args.summary ? `\n${args.summary}` : '',
        `\n${base}/calls/${args.callId}`,
      ].filter(Boolean).join(''),
      priority: type === 'complaint' ? TicketPriority.high : TicketPriority.normal,
      category: type === 'complaint' ? TicketCategory.complaint : TicketCategory.other,
    });
  } catch (err) {
    console.error('[CALL_TICKET] raiseTicketFromAiCall failed:', err);
  }
}

// ── 2. A person answered ────────────────────────────────────────────────────

/** Fetch the Twilio recording and transcribe it. Returns null on any failure —
 *  a missing transcript must never hold up anything else. */
async function transcribeRecording(recordingUrl: string): Promise<string | null> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token || !process.env.OPENAI_API_KEY) return null;

  try {
    // Twilio serves the media from the same URL with a format suffix.
    const url = recordingUrl.endsWith('.mp3') ? recordingUrl : `${recordingUrl}.mp3`;
    const res = await fetch(url, {
      headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}` },
    });
    if (!res.ok) {
      console.error(`[CALL_TICKET] recording fetch failed: ${res.status}`);
      return null;
    }
    const audio = Buffer.from(await res.arrayBuffer());
    const file = new File([new Uint8Array(audio)], 'call.mp3', { type: 'audio/mpeg' });

    const out = await oa().audio.transcriptions.create({ file, model: 'whisper-1' });
    return out.text?.trim() || null;
  } catch (err) {
    console.error('[CALL_TICKET] transcription failed:', err);
    return null;
  }
}

interface FollowUp {
  needed: boolean;
  title: string;
  summary: string;
  urgent: boolean;
  /** Plain summary of the whole call, needed or not — the call is kept either way now. */
  callSummary: string;
}

/**
 * Decide whether a call somebody already handled still needs a ticket.
 *
 * The bar is deliberately high. Most calls a person takes are finished when they
 * hang up, and a ticket for each one recreates exactly the noise we spent the
 * evening removing from the email queue. Only an outstanding, unfinished
 * commitment counts.
 */
async function decideFollowUp(transcript: string): Promise<FollowUp | null> {
  try {
    const r = await oa().chat.completions.create({
      model: 'gpt-4.1-mini',
      temperature: 0,
      max_tokens: 220,
      messages: [
        {
          role: 'system',
          content:
            'You read transcripts of phone calls answered by a member of the ReceptionMate team and decide whether anything is still OUTSTANDING afterwards.\n\n' +
            'Answer "needed": true ONLY if someone promised to do something, owes the caller a reply, or raised a problem that was not resolved on the call. ' +
            'Answer false for calls that concluded — a question answered, a booking made, a chat, a wrong number, or nothing of substance.\n\n' +
            'Reply with JSON only: {"needed":boolean,"title":"short summary under 70 chars","summary":"what is outstanding and who owes what, 1-2 sentences","urgent":boolean,"callSummary":"2-3 sentences on what the call was about and what was agreed, written whether or not anything is outstanding"}',
        },
        { role: 'user', content: transcript.slice(0, 8000) },
      ],
      response_format: { type: 'json_object' },
    });

    const raw = r.choices[0]?.message?.content;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<FollowUp>;
    if (typeof parsed.needed !== 'boolean') return null;
    return {
      needed: parsed.needed,
      title: String(parsed.title || 'Call needs follow-up').slice(0, 200),
      summary: String(parsed.summary || ''),
      urgent: parsed.urgent === true,
      callSummary: String(parsed.callSummary || ''),
    };
  } catch (err) {
    console.error('[CALL_TICKET] follow-up decision failed:', err);
    return null;
  }
}

/** The 8-digit id the calls API hands out, so a kept call looks like any other in the portal. */
async function newCallId(): Promise<string> {
  for (let i = 0; i < 20; i += 1) {
    const id = String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
    if (!(await prisma.call.findUnique({ where: { id } }))) return id;
  }
  throw new Error('could not allocate a call id');
}

/**
 * Write the call down. A screened call answered by a PERSON produces no agent session, so
 * nothing ever posted it to /api/calls and it existed only as Twilio billing.
 *
 * It was worse than merely unlogged: we fetched the recording and transcribed it purely to ask
 * an AI whether anything was outstanding, and threw the transcript away when the answer was no.
 * A 22-minute call to our own line on 29 Sep 2026 was recorded, transcribed, judged "no
 * follow-up needed" and left no trace. The words already exist by the time we get here — the
 * only thing missing was keeping them.
 *
 * Deliberately NOT gated on SUPPORT_TICKET_GARAGE_IDS. That list decides whose calls WE answer
 * and so whose calls belong in OUR support queue; it has nothing to do with whether a garage
 * gets to see its own call. The ticket below is still gated by it.
 */
async function keepScreenedCall(args: {
  garageId: string;
  transcript: string;
  summary: string;
  callerPhone?: string | null;
  callSid?: string | null;
  recordingSid?: string | null;
  recordingDurationSeconds?: number | null;
}): Promise<void> {
  try {
    if (args.callSid) {
      const existing = await prisma.call.findFirst({ where: { twilioCallSid: args.callSid } });
      if (existing) return; // the callback can fire more than once
    }

    const seconds = Math.max(0, Math.round(args.recordingDurationSeconds ?? 0));
    const completedAt = new Date();
    // Recording starts when the person picks up, so this is when the conversation began — far
    // closer than stamping it at callback time, which for a 22-minute call is 22 minutes late.
    const startedAt = new Date(completedAt.getTime() - seconds * 1000);

    await prisma.call.create({
      data: {
        id: await newCallId(),
        garageId: args.garageId,
        roomName: `screened-${args.callSid || completedAt.getTime()}`,
        createdAt: startedAt,
        durationSeconds: seconds,
        // 'other' rather than a new label: the classifier maps a value it does not know onto
        // 'other' anyway, and inventing a category here would skew every dashboard that counts
        // them. Who answered is recorded in metrics and said plainly in the summary.
        callType: 'other',
        fromNumber: args.callerPhone || undefined,
        customerPhone: args.callerPhone || undefined,
        twilioCallSid: args.callSid || undefined,
        summary: `Answered by a person (screened call). ${args.summary}`.trim(),
        // Whisper gives no speaker labels, so this is one block of speech and is marked as such
        // rather than split into turns we would be guessing at.
        transcript: [
          { type: 'message', speaker: 'system', text: args.transcript, timestamp: 0 },
        ],
        metrics: {
          source: 'screened-call',
          answeredBy: 'person',
          transcriptSource: 'whisper-whole-call',
          recordingDurationSeconds: seconds,
        },
        ...(args.recordingSid
          ? {
              recordingUrl: args.recordingSid,
              recordingDurationSeconds: seconds,
              recordingCompletedAt: completedAt,
            }
          : {}),
      },
    });
    console.log(`[CALL_TICKET] kept screened call for garage ${args.garageId} (${seconds}s)`);
  } catch (err) {
    // Keeping the call must never cost us the ticket below.
    console.error('[CALL_TICKET] could not keep the screened call:', err);
  }
}

export async function raiseTicketFromScreenedCall(args: {
  garageId: string;
  recordingUrl: string;
  callerPhone?: string | null;
  callSid?: string | null;
  recordingSid?: string | null;
  recordingDurationSeconds?: number | null;
}): Promise<void> {
  try {
    const garage = await prisma.garage.findUnique({
      where: { id: args.garageId },
      select: { name: true },
    });
    if (!garage) return;

    const transcript = await transcribeRecording(args.recordingUrl);
    if (!transcript) return;

    const verdict = await decideFollowUp(transcript);

    await keepScreenedCall({
      garageId: args.garageId,
      transcript,
      summary: verdict?.callSummary || '',
      callerPhone: args.callerPhone,
      callSid: args.callSid,
      recordingSid: args.recordingSid,
      recordingDurationSeconds: args.recordingDurationSeconds,
    });

    // The ticket, and only the ticket, is scoped to the lines we answer ourselves.
    if (!raisesTickets(args.garageId)) return;
    if (!verdict?.needed) {
      console.log(`[CALL_TICKET] screened call at ${garage.name} needs no follow-up`);
      return;
    }

    await createCallTicket({
      garageId: args.garageId,
      garageName: garage.name,
      callerPhone: args.callerPhone,
      title: verdict.title,
      body: [
        'This call was answered by a person. Transcribed afterwards, and something is still outstanding:',
        `\n${verdict.summary}`,
        '\n\n--- Transcript ---\n',
        transcript.slice(0, 6000),
      ].join(''),
      priority: verdict.urgent ? TicketPriority.high : TicketPriority.normal,
    });
  } catch (err) {
    console.error('[CALL_TICKET] raiseTicketFromScreenedCall failed:', err);
  }
}
