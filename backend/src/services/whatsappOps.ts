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

// ms to add to UTC to get London wall-clock (+1h during BST, 0 during GMT) at a given instant.
const londonOffsetMs = (d: Date): number =>
  new Date(d.toLocaleString('en-US', { timeZone: 'Europe/London' })).getTime() -
  new Date(d.toLocaleString('en-US', { timeZone: 'UTC' })).getTime();

// The UTC instant of 00:00 UK-local on the given "YYYY-MM-DD" (+ addDays). Used so date
// queries match the calendar day people mean, not the UTC day (they differ by ~1h in summer).
const ukDayStart = (dateStr: string, addDays = 0): Date => {
  const [y, mo, d] = String(dateStr).split('-').map(Number);
  const guess = new Date(Date.UTC(y, (mo || 1) - 1, (d || 1) + addDays, 0, 0, 0));
  return new Date(guess.getTime() - londonOffsetMs(guess));
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
      description: 'List calls for a garage (or all), newest first. Returns a count plus id, date, type, whether a booking was confirmed, duration, and a summary snippet. To answer "were there any calls on <date>" use on_date (or date_from/date_to for a range) — dates are matched in UK local time and return EVERY call that day, so trust the count.',
      parameters: {
        type: 'object',
        properties: {
          garage: { type: 'string', description: 'Garage name or id (optional — omit for all garages)' },
          limit: { type: 'integer', description: 'Max calls (default 10, max 40). Ignored when a date filter is used — those return all matching calls.' },
          only_bookings: { type: 'boolean', description: 'Only calls where a booking was confirmed' },
          since_days_ago: { type: 'integer', description: 'Only calls in the last N days' },
          on_date: { type: 'string', description: 'A single calendar day as "YYYY-MM-DD" (UK local time). Resolve day/month names ("the 29th", "June 29") against today\'s date before calling. Returns all calls that day.' },
          date_from: { type: 'string', description: 'Range start "YYYY-MM-DD" (UK local, inclusive). Use with date_to.' },
          date_to: { type: 'string', description: 'Range end "YYYY-MM-DD" (UK local, inclusive).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'booking_stats',
      description: 'DB-computed totals per garage for a date range: number of calls and confirmed bookings, sorted by bookings (desc). Use this for aggregate questions like "who has the most bookings in June", "bookings per garage", totals. Never answer aggregate questions by eyeballing call lists — always use this.',
      parameters: {
        type: 'object',
        properties: {
          month: { type: 'string', description: 'Calendar month as "YYYY-MM" (e.g. "2026-06" for June). Use today\'s date to resolve month names.' },
          since_days_ago: { type: 'integer', description: 'Alternative to month: last N days.' },
          garage: { type: 'string', description: 'Optional — restrict to one garage.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_call',
      description: 'Full detail for one call by id: summary, booking outcome, and the complete transcript including every tool call with its input params, result, success and duration_ms. For trace-enabled agents it also returns api_calls (raw external API request/response bodies + HTTP status + error, e.g. the exact createSale body the garage system rejected) and errors — use these to diagnose why a booking/API step failed.',
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
    // Date filters are matched in UK local time (calls are stored UTC). on_date = one day;
    // date_from/date_to = an inclusive range. A date filter returns EVERY matching call.
    const dated = Boolean(args.on_date || args.date_from || args.date_to);
    if (dated) {
      const from = ukDayStart(args.on_date || args.date_from || args.date_to);
      const to = ukDayStart(args.on_date || args.date_to || args.date_from, 1); // exclusive next-day start
      where.createdAt = { gte: from, lt: to };
    } else if (args.since_days_ago) {
      where.createdAt = { gte: new Date(Date.now() - args.since_days_ago * 86400000) };
    }
    const calls = await prisma.call.findMany({
      where, orderBy: { createdAt: dated ? 'asc' : 'desc' }, take: dated ? 500 : Math.min(args.limit || 10, 40),
      select: { id: true, createdAt: true, callType: true, confirmedBooking: true, durationSeconds: true, summary: true, garage: { select: { name: true } } },
    });
    const rows = calls.map((c) => ({
      id: c.id, garage: c.garage?.name, date: c.createdAt.toISOString(), type: c.callType,
      booked: c.confirmedBooking, duration_s: c.durationSeconds, summary: clip(c.summary, 240),
    }));
    return { count: rows.length, ...(dated ? { window_uk_local: args.on_date || `${args.date_from || ''}..${args.date_to || ''}` } : {}), calls: rows };
  }
  if (name === 'booking_stats') {
    // Resolve the date window.
    let gte: Date, lt: Date;
    if (typeof args.month === 'string' && /^\d{4}-\d{2}$/.test(args.month)) {
      const [y, m] = args.month.split('-').map(Number);
      gte = new Date(Date.UTC(y, m - 1, 1));
      lt = new Date(Date.UTC(y, m, 1));
    } else if (args.since_days_ago) {
      gte = new Date(Date.now() - args.since_days_ago * 86400000);
      lt = new Date();
    } else {
      // default: current calendar month
      const now = new Date();
      gte = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      lt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    }
    const g = await findGarage(args.garage);
    const scope: any = { createdAt: { gte, lt } };
    if (g) scope.garageId = g.id;
    else if (args.garage) return { error: `No garage matched "${args.garage}"` };
    const [totals, booked] = await Promise.all([
      prisma.call.groupBy({ by: ['garageId'], where: scope, _count: { _all: true } }),
      prisma.call.groupBy({ by: ['garageId'], where: { ...scope, confirmedBooking: true }, _count: { _all: true } }),
    ]);
    const bookedMap = new Map(booked.map((b) => [b.garageId, b._count._all]));
    const gs = await prisma.garage.findMany({ where: { id: { in: totals.map((t) => t.garageId) } }, select: { id: true, name: true } });
    const nameMap = new Map(gs.map((x) => [x.id, x.name]));
    const rows = totals
      .map((t) => ({ garage: nameMap.get(t.garageId) || t.garageId, calls: t._count._all, bookings: bookedMap.get(t.garageId) || 0 }))
      .sort((a, b) => b.bookings - a.bookings);
    return {
      window: { from: gte.toISOString().slice(0, 10), to: lt.toISOString().slice(0, 10) },
      note: '"bookings" = calls flagged confirmedBooking=true',
      total_bookings: rows.reduce((s, r) => s + r.bookings, 0),
      per_garage: rows,
    };
  }
  if (name === 'get_call') {
    const c = await prisma.call.findUnique({ where: { id: String(args.call_id) }, include: { garage: { select: { name: true } } } });
    if (!c) return { error: 'call not found' };
    const events = parseTranscript(c.transcript).map((e: any) => {
      if (e?.type === 'tool_call') return { t: e.timestamp, tool: e.tool, params: e.parameters, result: clip(e.result, 600), success: e.success, duration_ms: e.duration_ms };
      if (e?.type === 'message' || e?.role) return { t: e.timestamp ?? e.ts, [e.speaker || e.role]: clip(e.text, 400) };
      return e;
    });
    // Phase-2 fault trace (agents on AGENT_TRACE ship it in metrics.trace): raw external
    // API request/response bodies, per-turn pipeline metrics and errors. Only present for
    // trace-enabled agents; older/other calls simply won't have it.
    const m = c.metrics as any;
    // Two trace shapes: metrics.trace (Tyresoft/new agents, via call_trace, gated by AGENT_TRACE)
    // and metrics.gh_trace (GarageHive agent, always-on) — normalise both into one api_calls list.
    const rawTrace: any[] = Array.isArray(m?.trace) ? m.trace : [];
    const traceApiCalls = rawTrace
      .filter((e) => e?.type === 'api_call')
      .map((e) => ({ t: e.ts, name: e.name, status: e.status, duration_ms: e.duration_ms, error: e.error, request: clip(e.request, 1500), response: clip(e.response, 2000) }));
    const ghTrace: any[] = Array.isArray(m?.gh_trace) ? m.gh_trace : [];
    const ghApiCalls = ghTrace.map((e) => ({ name: e.path, method: e.method, status: e.status, request: clip(e.payload, 1500), response: clip(e.response, 2000) }));
    const apiCalls = [...traceApiCalls, ...ghApiCalls];
    const traceErrors = rawTrace.filter((e) => e?.type === 'error').map((e) => ({ t: e.ts, where: e.where, detail: clip(e.detail, 600) }));
    return {
      id: c.id, garage: c.garage?.name, date: c.createdAt.toISOString(), type: c.callType,
      booked: c.confirmedBooking, booking_details: c.bookingDetails, duration_s: c.durationSeconds,
      summary: c.summary, transcript: events,
      ...(apiCalls.length ? { api_calls: apiCalls } : {}),
      ...(traceErrors.length ? { errors: traceErrors } : {}),
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
- When diagnosing a failure, cite the concrete evidence from the transcript/tool calls (e.g. the exact tool that failed and its error/result). get_call also returns api_calls (raw external API request/response bodies + status) when available — use them to name the exact rejection (e.g. what the booking API returned).
- For a broad "why" question (e.g. "why isn't <garage> getting many bookings?"), don't guess: first call booking_stats for the period, then list_recent_calls scoped to that garage, then get_call on several recent NON-booked calls, and identify the common drop-off point — no availability, price objection, registration/vehicle lookup failing, caller hangs up, or the booking API rejecting the sale. Summarise the pattern with counts (e.g. "4 of the last 8 dropped at the price step") and cite an example call id.
- If a request is ambiguous (which garage? which call?), make a sensible default (most recent) and say so, rather than asking a question. "check the traces"/"the last call" with no id = pull the single most recent call via list_recent_calls and analyse it.`;

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
    { role: 'system', content: `${SYSTEM}\nToday's date is ${new Date().toISOString().slice(0, 10)}. Resolve relative periods ("June", "this month", "last week", "the 29th") against it, in UK local time. For any "how many / who has the most / per garage" question, call booking_stats — never count from call lists. For "were there any calls on <date>" / calls on a specific day, call list_recent_calls with on_date (UK local) and report its count field — never infer a specific date by eyeballing a recency list.` },
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
