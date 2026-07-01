// ─────────────────────────────────────────────────────────────────────────────
// WhatsApp Ops / Diagnostics assistant.
//
// A message from an allow-listed ADMIN number (WHATSAPP_ADMIN_NUMBERS) is handled
// here instead of by the customer-facing receptionist. It's a Claude/GPT agent with
// read-only tools over the portal DB, so the team can diagnose calls/bookings from
// their phone. Fully self-contained + read-only — it never writes to garage data and
// is wired into the webhook behind an admin check + try/catch, so it cannot affect
// the normal customer flow.
// ─────────────────────────────────────────────────────────────────────────────
import OpenAI from 'openai';
import axios from 'axios';
import { prisma } from '../db.js';

let _client: OpenAI | null = null;
const client = (): OpenAI => (_client ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY }));

const MODEL = process.env.WHATSAPP_OPS_MODEL || 'gpt-4o';

export function isWhatsappAdmin(from: string): boolean {
  const raw = process.env.WHATSAPP_ADMIN_NUMBERS || '';
  if (!raw.trim()) return false;
  const norm = (n: string) => n.replace(/[^\d]/g, '');
  const target = norm(from);
  return raw.split(',').map((n) => norm(n)).filter(Boolean).some((n) => n === target || target.endsWith(n) || n.endsWith(target));
}

// ── Short in-memory conversation memory per admin number (best-effort; resets on
//    restart). Keeps follow-ups like "show me that call's trace" working. ──
type Turn = { role: 'user' | 'assistant'; content: string };
const history = new Map<string, Turn[]>();
const HIST_MAX = 10;

// ── Helpers ──────────────────────────────────────────────────────────────────
const clip = (v: unknown, n = 1500): string => {
  let s: string;
  try { s = typeof v === 'string' ? v : JSON.stringify(v); } catch { s = String(v); }
  return s.length <= n ? s : s.slice(0, n) + `…(+${s.length - n} chars)`;
};

const parseTranscript = (t: unknown): any[] => {
  if (Array.isArray(t)) return t;
  if (typeof t === 'string') { try { return JSON.parse(t) || []; } catch { return []; } }
  return [];
};

async function findGarage(nameOrId?: string) {
  if (!nameOrId) return null;
  return (
    (await prisma.garage.findFirst({ where: { id: nameOrId }, select: { id: true, name: true } })) ||
    (await prisma.garage.findFirst({ where: { name: { contains: nameOrId, mode: 'insensitive' } }, select: { id: true, name: true } }))
  );
}

// ── Read-only tools ────────────────────────────────────────────────────────────
const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  { type: 'function', function: { name: 'list_garages', description: 'List all garages (name + id).', parameters: { type: 'object', properties: {} } } },
  {
    type: 'function',
    function: {
      name: 'list_recent_calls',
      description: 'Recent calls for a garage (or all), newest first. Returns id, date, type, whether a booking was confirmed, duration, and a summary snippet.',
      parameters: {
        type: 'object',
        properties: {
          garage: { type: 'string', description: 'Garage name or id (optional — omit for all garages)' },
          limit: { type: 'integer', description: 'Max calls (default 10, max 40)' },
          only_bookings: { type: 'boolean', description: 'Only calls where a booking was confirmed' },
          since_days_ago: { type: 'integer', description: 'Only calls in the last N days' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_call',
      description: 'Full detail for one call by id: summary, booking outcome, and the complete transcript including every tool call with its input params, result, success and duration_ms.',
      parameters: { type: 'object', properties: { call_id: { type: 'string' } }, required: ['call_id'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_calls',
      description: 'Find calls whose summary/transcript contains a text query (e.g. a reg, name, "brake", "no availability"). Optionally scope to a garage and recency.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text to look for' },
          garage: { type: 'string' },
          since_days_ago: { type: 'integer' },
          limit: { type: 'integer', description: 'default 10, max 30' },
        },
        required: ['query'],
      },
    },
  },
];

async function runTool(name: string, args: any): Promise<unknown> {
  if (name === 'list_garages') {
    const gs = await prisma.garage.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } });
    return gs;
  }
  if (name === 'list_recent_calls') {
    const g = await findGarage(args.garage);
    const where: any = {};
    if (g) where.garageId = g.id;
    else if (args.garage) return { error: `No garage matched "${args.garage}"` };
    if (args.only_bookings) where.confirmedBooking = true;
    if (args.since_days_ago) where.createdAt = { gte: new Date(Date.now() - args.since_days_ago * 86400000) };
    const calls = await prisma.call.findMany({
      where, orderBy: { createdAt: 'desc' }, take: Math.min(args.limit || 10, 40),
      select: { id: true, createdAt: true, callType: true, confirmedBooking: true, durationSeconds: true, summary: true, garage: { select: { name: true } } },
    });
    return calls.map((c) => ({
      id: c.id, garage: c.garage?.name, date: c.createdAt.toISOString(), type: c.callType,
      booked: c.confirmedBooking, duration_s: c.durationSeconds, summary: clip(c.summary, 240),
    }));
  }
  if (name === 'get_call') {
    const c = await prisma.call.findUnique({ where: { id: String(args.call_id) }, include: { garage: { select: { name: true } } } });
    if (!c) return { error: 'call not found' };
    const events = parseTranscript(c.transcript).map((e: any) => {
      if (e?.type === 'tool_call') return { t: e.timestamp, tool: e.tool, params: e.parameters, result: clip(e.result, 600), success: e.success, duration_ms: e.duration_ms };
      if (e?.type === 'message' || e?.role) return { t: e.timestamp ?? e.ts, [e.speaker || e.role]: clip(e.text, 400) };
      return e;
    });
    return {
      id: c.id, garage: c.garage?.name, date: c.createdAt.toISOString(), type: c.callType,
      booked: c.confirmedBooking, booking_details: c.bookingDetails, duration_s: c.durationSeconds,
      summary: c.summary, transcript: events,
    };
  }
  if (name === 'search_calls') {
    const g = await findGarage(args.garage);
    const where: any = { OR: [{ summary: { contains: args.query, mode: 'insensitive' } }, { transcript: { contains: args.query, mode: 'insensitive' } }] };
    if (g) where.garageId = g.id;
    if (args.since_days_ago) where.createdAt = { gte: new Date(Date.now() - args.since_days_ago * 86400000) };
    const calls = await prisma.call.findMany({
      where, orderBy: { createdAt: 'desc' }, take: Math.min(args.limit || 10, 30),
      select: { id: true, createdAt: true, callType: true, confirmedBooking: true, summary: true, garage: { select: { name: true } } },
    });
    return calls.map((c) => ({ id: c.id, garage: c.garage?.name, date: c.createdAt.toISOString(), booked: c.confirmedBooking, summary: clip(c.summary, 240) }));
  }
  return { error: `unknown tool ${name}` };
}

const SYSTEM = `You are ReceptionMate's internal Ops & Diagnostics assistant, reached over WhatsApp by the ReceptionMate team (not customers). Help them diagnose calls, bookings and agent behaviour.
- Use the read-only tools to fetch REAL data. Never invent call IDs, transcripts or results.
- Be concise and mobile-friendly: short paragraphs, plain text (WhatsApp has no markdown tables). Lead with the answer.
- When diagnosing a failure, cite the concrete evidence from the transcript/tool calls (e.g. the exact tool that failed and its error/result).
- If a request is ambiguous (which garage? which call?), make a sensible default (most recent) and say so, rather than asking a question every time.`;

async function sendWhatsApp(phoneNumberId: string, accessToken: string, to: string, body: string): Promise<void> {
  await axios.post(
    `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
    { messaging_product: 'whatsapp', to, type: 'text', text: { body: body.slice(0, 4000) } },
    { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } },
  );
}

export async function handleAdminOpsMessage(opts: {
  from: string; text: string; phoneNumberId: string; accessToken: string;
}): Promise<void> {
  const { from, text, phoneNumberId, accessToken } = opts;
  console.log(`[WhatsApp Ops] request from ${from}: ${text.slice(0, 120)}`);
  const prior = history.get(from) || [];
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM },
    ...prior.map((t) => ({ role: t.role, content: t.content } as OpenAI.Chat.Completions.ChatCompletionMessageParam)),
    { role: 'user', content: text },
  ];

  let final = '';
  for (let step = 0; step < 6; step++) {
    const resp = await client().chat.completions.create({ model: MODEL, messages, tools, tool_choice: 'auto' });
    const msg = resp.choices[0].message;
    messages.push(msg);
    if (msg.tool_calls && msg.tool_calls.length) {
      for (const tc of msg.tool_calls) {
        let result: unknown;
        try { result = await runTool(tc.function.name, JSON.parse(tc.function.arguments || '{}')); }
        catch (e) { result = { error: (e as Error).message }; }
        messages.push({ role: 'tool', tool_call_id: tc.id, content: clip(result, 9000) });
      }
      continue;
    }
    final = msg.content || '';
    break;
  }
  if (!final) final = "Sorry — I couldn't work that out. Try naming the garage or a call id.";

  history.set(from, [...prior, { role: 'user', content: text }, { role: 'assistant', content: final }].slice(-HIST_MAX));
  console.log(`[WhatsApp Ops] replying to ${from} (${final.length} chars)`);
  try {
    await sendWhatsApp(phoneNumberId, accessToken, from, final);
    console.log(`[WhatsApp Ops] reply sent OK to ${from}`);
  } catch (e: any) {
    console.error('[WhatsApp Ops] SEND FAILED:', JSON.stringify(e?.response?.data?.error || e?.message || e));
  }
}
