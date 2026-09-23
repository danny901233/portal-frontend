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
  const contact = phone
    ? await prisma.contact.upsert({
        where: { phone },
        update: args.callerName ? { name: args.callerName } : {},
        create: { phone, name: args.callerName ?? undefined, garageId: args.garageId },
      })
    : await prisma.contact.create({
        data: { name: args.callerName ?? 'Withheld number', garageId: args.garageId },
      });

  const ticket = await prisma.ticket.create({
    data: {
      title: args.title.slice(0, 300),
      channel: TicketChannel.phone,
      category: args.category ?? TicketCategory.other,
      priority: args.priority ?? TicketPriority.normal,
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
            'Reply with JSON only: {"needed":boolean,"title":"short summary under 70 chars","summary":"what is outstanding and who owes what, 1-2 sentences","urgent":boolean}',
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
    };
  } catch (err) {
    console.error('[CALL_TICKET] follow-up decision failed:', err);
    return null;
  }
}

export async function raiseTicketFromScreenedCall(args: {
  garageId: string;
  recordingUrl: string;
  callerPhone?: string | null;
}): Promise<void> {
  try {
    if (!raisesTickets(args.garageId)) return;

    const garage = await prisma.garage.findUnique({
      where: { id: args.garageId },
      select: { name: true },
    });
    if (!garage) return;

    const transcript = await transcribeRecording(args.recordingUrl);
    if (!transcript) return;

    const verdict = await decideFollowUp(transcript);
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
