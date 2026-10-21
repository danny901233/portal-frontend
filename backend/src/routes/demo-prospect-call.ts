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

/**
 * Dial the unified agent for this garage or prospect id.
 *
 * The SIP user is "garage-<id>", not the bare id, because that string BECOMES the room name: the
 * dispatch rule is a callee rule with no prefix, so the room is named exactly what is dialled, and
 * the agent reads the garage out of "garage-<id>".
 *
 * A prefix on the rule looked like the tidier way to do that and silently broke it. LiveKit joins
 * prefix and callee with an underscore, so room_prefix "garage-" produced
 * "garage-_50a82485-…", the agent's ^garage-([0-9a-fA-F-]{6,}) found no match, no config loaded,
 * and every caller was greeted as "the garage" — its _DEFAULT_BRANCH. The id has to arrive as part
 * of the dialled string, with nothing inserted into it.
 *
 * The trunk matches on the called number, so its numbers are these same garage-<id> strings.
 */
const dialAgent = (id: string): string =>
  xml(`  <Dial><Sip>sip:garage-${id}@${SIP_DOMAIN()}${SIP_EDGE}</Sip></Dial>`);

/**
 * Fall back to the shared demo garage.
 *
 * Dialled as the BARE id, unlike a prospect. The demo garage is a real garage with its own trunk
 * and its own rule, and that trunk's numbers list the plain uuid — so "garage-<id>" would match no
 * trunk at all and the fallback would fail the call instead of softening it.
 */
const dialSharedDemo = (): string =>
  xml(`  <Dial><Sip>sip:${DEMO_GARAGE_ID}@${SIP_DOMAIN()}${SIP_EDGE}</Sip></Dial>`);

const say = (line: string) =>
  xml(`  <Say voice="Polly.Amy-Neural">${line}</Say>\n  <Hangup/>`);

/**
 * A UK number in one canonical form, so the stored and dialled spellings compare exactly.
 *
 * Exactly, not by a tail. Comparing the last nine digits looked tolerant and was wrong: the
 * landline 01733 342264 and the mobile 07733 342264 share their last nine digits, so a stranger
 * ringing from that mobile would have been greeted as Thompson Service Centre. Only the full
 * number can decide this.
 *
 * Returns '' for anything it cannot place, and '' never matches a stored number.
 */
const normaliseUkPhone = (phone: string): string => {
  let d = (phone || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('44')) d = d.slice(2);
  else if (d.startsWith('0')) d = d.slice(1);
  else return '';                     // not a UK number in any spelling we issue links to
  // A UK national significant number is 9 or 10 digits after the trunk prefix.
  if (d.length < 9 || d.length > 10) return '';
  return `+44${d}`;
};

/**
 * Identify the caller by the number they rang from, before resorting to tones.
 *
 * This is the silent path. A garage owner ringing from the garage's own line is recognised with no
 * beeps and no pause at all, because we already hold that number from Google for every prospect
 * with a placeId. It does nothing for a call from a personal mobile, which is why the DTMF path
 * stays — but when it hits, it is the experience the demo should have.
 *
 * CALLER ID IS NOT PROOF OF IDENTITY. It is spoofable, and a garage's number is published on its
 * own website, so this is a convenience and not an authentication step. What it can get you is a
 * demo answering in that garage's name, using facts already on their public site, against a
 * practice diary — and, if you then hold a conversation past the summary thresholds, one email to
 * that garage describing a call they did not make. That is a nuisance rather than a breach, and
 * it is the reason nothing behind this line is allowed to touch a real diary or a real customer
 * record. If it ever needs to be airtight, the answer is to drop this path and keep the tones.
 */
const prospectByCallerId = async (from: string) => {
  const caller = normaliseUkPhone(from);
  if (!caller) return null;
  try {
    const candidates = await prisma.demoProspect.findMany({
      where: { phoneNumber: { not: null }, builtAt: { not: null }, expiresAt: { gt: new Date() } },
      select: { id: true, agentId: true, spokenName: true, phoneNumber: true },
    });
    return candidates.find((c) => normaliseUkPhone(c.phoneNumber || '') === caller) ?? null;
  } catch (err) {
    console.error('[DEMO_CALL] caller-id lookup failed', err);
    return null;
  }
};

/**
 * The call lands here. Try the caller's number first, then collect the code.
 *
 * TIMING IS THE WHOLE GAME ON THE GATHER. The dial string is "...,,,<code>#", and each comma is
 * roughly two seconds of pause on iOS — so the tones arrive about six seconds after the call
 * connects. The first version waited four, gave up before they landed, and sent three real test
 * calls to the generic demo while the caller could plainly hear their own handset sending the
 * code. The wait now comfortably outlasts the pause, and finishOnKey ends it the moment the
 * trailing # arrives rather than sitting out the full timeout.
 *
 * The short line inside the Gather is for whoever dialled the number by hand: without it they get
 * ten seconds of dead air. Digits interrupt it, so a link caller loses nothing.
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

  // The silent path: recognised by the number they rang from, so no tones and no waiting.
  const known = await prospectByCallerId(from);
  if (known) {
    prisma.demoProspect
      .update({ where: { id: known.id }, data: { lastCalledAt: new Date(), callCount: { increment: 1 } } })
      .catch((err) => console.error('[DEMO_CALL] could not record the call', err));
    console.log(`[DEMO_CALL] ${known.spokenName} (agent ${known.agentId}) by caller id ${from}`);
    return res.type('text/xml').send(dialAgent(known.agentId));
  }

  const base = process.env.PORTAL_BASE_URL || 'https://portal.receptionmate.co.uk';
  return res.type('text/xml').send(xml(
    `  <Gather numDigits="5" timeout="10" finishOnKey="#" action="${base}/webhooks/demo-prospect-call/connect" method="POST">\n` +
    // Two sentences, for two kinds of caller. Someone who tapped the link is already sending the
    // code as tones and will cut this off — finishOnKey ends the Gather the moment the # lands, so
    // they hear the first few words at most. Someone who DIALLED the number off the email hears
    // the whole thing, and the second sentence is the only thing that stops them being stranded on
    // the generic demo.
    `    <Say voice="Polly.Amy-Neural">One moment, I'm just building your receptionist. `
    + `If you have a code from the email, type it in now.</Say>\n` +
    `  </Gather>\n` +
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
    return res.type('text/xml').send(dialSharedDemo());
  }

  try {
    const prospect = await prisma.demoProspect.findUnique({
      where: { code: digits },
      select: { id: true, agentId: true, spokenName: true, builtAt: true, expiresAt: true },
    });
    if (!prospect || !prospect.builtAt || prospect.expiresAt.getTime() <= Date.now()) {
      console.warn(`[DEMO_CALL] code ${digits} ${!prospect ? 'unknown' : !prospect.builtAt ? 'not built' : 'expired'} — generic demo`);
      return res.type('text/xml').send(dialSharedDemo());
    }

    // Best-effort: the call matters more than the counter.
    prisma.demoProspect
      .update({ where: { id: prospect.id }, data: { lastCalledAt: new Date(), callCount: { increment: 1 } } })
      .catch((err) => console.error('[DEMO_CALL] could not record the call', err));

    console.log(`[DEMO_CALL] ${prospect.spokenName} (agent ${prospect.agentId}) by code`);
    return res.type('text/xml').send(dialAgent(prospect.agentId));
  } catch (err) {
    console.error('[DEMO_CALL] lookup failed — generic demo', err);
    return res.type('text/xml').send(dialSharedDemo());
  }
});

export default router;
