// The phone leg of the cold-prospect demo: one shared number that answers as whichever garage the
// caller's link belongs to.
//
// HOW THE GARAGE IS CHOSEN. The link on /try/<slug> dials
//   tel:+441708985485,,,<code>#
// so the handset sends the prospect's 5-digit code as DTMF by itself — they never see a reference
// number. This webhook reads those tones, looks the code up, and dials
//   sip:<agentId>@<unified SIP domain>
// A `callee` dispatch rule on the prospect trunk names the room after that SIP user part, giving
// "garage-<agentId>", which is exactly the shape the unified agent already parses to find a garage
// (garage_id_from_room in agent.py). So one number serves every prospect, and no per-prospect
// telephony is created — the same reason there is no Garage row for them.
//
// WHY NOT /webhooks/voice. That route requires an AgentConfiguration row AND a Garage row, and
// refuses the call ("Configuration not found for this garage") without both. Prospects
// deliberately have neither.
//
// NO RECORDING HERE, unlike the garage path. These are cold prospects who have been given no
// recording notice, and the summary email already tells them what the call did.

import type { Request, Response } from 'express';
import { Router } from 'express';
import twilio from 'twilio';
import { prisma } from '../db.js';

const router = Router();

/**
 * Only Twilio may drive these endpoints.
 *
 * Without this they are public, and both of the things that makes possible are worse than they
 * first look. A code is five digits — a hundred thousand of them — and the reply differs by
 * whether one resolves (the prospect's agent id comes back instead of the demo garage's), so the
 * pair becomes an oracle for enumerating the whole prospect list in minutes. That is the same
 * exposure the slug suffix was widened to 64 bits to prevent, and a DTMF code cannot be widened:
 * it has to stay short enough for a dialler to send.
 *
 * It also protects the shared ceiling below. The daily cap exists to bound cost, but an open
 * endpoint lets anyone exhaust it with 150 requests and take the demo line down for every real
 * prospect for the rest of the day.
 *
 * Mirrors the check on /api/sms/inbound. The URL is rebuilt from PORTAL_BASE_URL rather than the
 * Host header, because the signature is over the URL Twilio called and this runs behind nginx.
 */
const fromTwilio = (req: Request, path: string): boolean => {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    console.error('[DEMO_CALL] TWILIO_AUTH_TOKEN not set — refusing the call rather than serving an unauthenticated line');
    return false;
  }
  const signature = req.headers['x-twilio-signature'] as string | undefined;
  if (!signature) return false;
  const base = process.env.PORTAL_BASE_URL || `https://${req.headers.host}`;
  return twilio.validateRequest(authToken, signature, `${base}${path}`, req.body || {});
};

/** The shared demo garage, used whenever a call cannot be tied to a prospect. */
const DEMO_GARAGE_ID = 'c7f53608-b0eb-4bdd-93da-02f2875acd93';

const SIP_DOMAIN = () =>
  process.env.LIVEKIT_SIP_DOMAIN_UNIFIED || process.env.LIVEKIT_SIP_DOMAIN || '';

// Every LiveKit project and agent runs in eu-central, so pin Twilio's SIP edge to Frankfurt
// rather than letting it default to US Virginia and adding a transatlantic hop. Same reasoning,
// and the same string, as buildAgentDialTwiml in voice.ts.
const SIP_EDGE = ';edge=frankfurt';

// ── Abuse and cost ceiling ───────────────────────────────────────────────────────────────────
// The browser demo is capped at 2 per IP per hour. A phone call has no IP, so without its own
// ceiling this endpoint is an uncapped way to spend agent, LLM and TTS minutes — and the link goes
// out to hundreds of people at once. Keyed on the calling number, with a daily total as a backstop
// for withheld numbers, which all collapse onto one key.
const PER_CALLER_MAX = 3;
const PER_CALLER_WINDOW_MS = 60 * 60 * 1000;
const DAILY_MAX = Number(process.env.DEMO_PHONE_DAILY_MAX || 150);

const callsByNumber = new Map<string, { count: number; windowStart: number }>();
let dayStamp = '';
let dayCount = 0;

const overCeiling = (from: string): string | null => {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dayStamp) { dayStamp = today; dayCount = 0; }
  if (dayCount >= DAILY_MAX) return 'daily cap';
  const key = from || 'withheld';
  const now = Date.now();
  const b = callsByNumber.get(key);
  if (!b || now - b.windowStart >= PER_CALLER_WINDOW_MS) {
    callsByNumber.set(key, { count: 1, windowStart: now });
  } else if (b.count >= PER_CALLER_MAX) {
    return `${PER_CALLER_MAX} calls from ${key} within the hour`;
  } else {
    b.count += 1;
  }
  dayCount += 1;
  return null;
};

setInterval(() => {
  const cutoff = Date.now() - PER_CALLER_WINDOW_MS;
  for (const [k, b] of callsByNumber) if (b.windowStart < cutoff) callsByNumber.delete(k);
}, PER_CALLER_WINDOW_MS).unref();

const xml = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n${body}\n</Response>`;

/** Dial the unified agent as `garageOrAgentId`. */
const dialAgent = (id: string): string =>
  xml(`  <Dial><Sip>sip:${id}@${SIP_DOMAIN()}${SIP_EDGE}</Sip></Dial>`);

const say = (line: string) =>
  xml(`  <Say voice="Polly.Amy-Neural">${line}</Say>\n  <Hangup/>`);

/**
 * The call lands here. Collect the code without saying anything.
 *
 * No prompt on purpose: the tones arrive from the dial string within a moment of answering, so a
 * spoken "please enter your code" would be talking over them and would make a demo that is supposed
 * to feel like ringing a garage feel like ringing a call centre. Anyone who dialled the number by
 * hand enters nothing, the Gather times out, and they get the generic demo rather than a dead end.
 */
router.all('/demo-prospect-call', async (req: Request, res: Response) => {
  if (!fromTwilio(req, '/webhooks/demo-prospect-call')) {
    console.warn('[DEMO_CALL] rejected an unsigned request to the demo line');
    return res.status(403).type('text/xml').send(xml('  <Hangup/>'));
  }
  const from = String(req.body?.From || req.query?.From || '');
  // Checked after the signature on purpose: an unsigned request must not be able to consume the
  // shared daily allowance.
  const blocked = overCeiling(from);
  if (blocked) {
    console.warn(`[DEMO_CALL] refusing call from ${from || 'withheld'} — ${blocked}`);
    return res.type('text/xml').send(say('Sorry, the demo line is busy right now. Please try again later.'));
  }
  if (!SIP_DOMAIN()) {
    console.error('[DEMO_CALL] LIVEKIT_SIP_DOMAIN_UNIFIED is not set — cannot route the call');
    return res.type('text/xml').send(say('The demo line is not available right now.'));
  }

  const base = process.env.PORTAL_BASE_URL || 'https://portal.receptionmate.co.uk';
  return res.type('text/xml').send(xml(
    `  <Gather numDigits="5" timeout="4" action="${base}/webhooks/demo-prospect-call/connect" method="POST"/>\n` +
    `  <Redirect method="POST">${base}/webhooks/demo-prospect-call/connect</Redirect>`,
  ));
});

/**
 * The tones. Resolve them to a prospect and hand the caller to that prospect's agent.
 *
 * Anything unresolvable — no digits, an unknown code, an expired link, a prospect whose agent was
 * never built — falls back to the shared demo. A generic demo is a soft landing; a dead line from
 * someone we cold-emailed is not.
 */
router.post('/demo-prospect-call/connect', async (req: Request, res: Response) => {
  if (!fromTwilio(req, '/webhooks/demo-prospect-call/connect')) {
    console.warn('[DEMO_CALL] rejected an unsigned code lookup');
    return res.status(403).type('text/xml').send(xml('  <Hangup/>'));
  }
  const digits = String(req.body?.Digits || '').replace(/\D/g, '');
  if (!digits) {
    console.log('[DEMO_CALL] no code entered — generic demo');
    return res.type('text/xml').send(dialAgent(DEMO_GARAGE_ID));
  }

  try {
    const prospect = await prisma.demoProspect.findUnique({
      where: { code: digits },
      select: { id: true, agentId: true, spokenName: true, builtAt: true, expiresAt: true },
    });
    if (!prospect || !prospect.builtAt || prospect.expiresAt.getTime() <= Date.now()) {
      console.warn(`[DEMO_CALL] code ${digits} ${!prospect ? 'unknown' : !prospect.builtAt ? 'not built' : 'expired'} — generic demo`);
      return res.type('text/xml').send(dialAgent(DEMO_GARAGE_ID));
    }

    // Best-effort: the call matters more than the counter.
    prisma.demoProspect
      .update({ where: { id: prospect.id }, data: { lastCalledAt: new Date(), callCount: { increment: 1 } } })
      .catch((err) => console.error('[DEMO_CALL] could not record the call', err));

    console.log(`[DEMO_CALL] ${prospect.spokenName} (agent ${prospect.agentId}) by code`);
    return res.type('text/xml').send(dialAgent(prospect.agentId));
  } catch (err) {
    console.error('[DEMO_CALL] lookup failed — generic demo', err);
    return res.type('text/xml').send(dialAgent(DEMO_GARAGE_ID));
  }
});

export default router;
