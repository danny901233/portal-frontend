// Mint a short-lived LiveKit access token for the public talking-avatar
// demo at /demo on the marketing site. The room name is randomised so each
// visitor gets their own avatar instance — the agent worker spawns a new
// agent per room automatically.

import type { Request, Response } from 'express';
import type { Prisma } from '@prisma/client';
import { Router } from 'express';
import { AccessToken, AgentDispatchClient, RoomServiceClient } from 'livekit-server-sdk';
import { randomBytes } from 'crypto';
import { prisma } from '../db.js';

const router = Router();

// The dedicated "ReceptionMate Demo" garage. Web-demo calls are logged against it so they show
// up in the portal (under the Demo branch) with full transcript/detail, without ever touching a
// real customer's data or KPIs. Kept server-side so the demo agent never needs the garage id.
const DEMO_GARAGE_ID = 'c7f53608-b0eb-4bdd-93da-02f2875acd93';

const LIVEKIT_URL        = process.env.LIVEKIT_URL ?? '';
const LIVEKIT_API_KEY    = process.env.LIVEKIT_API_KEY ?? '';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET ?? '';

// Token TTL — long enough to cover a demo conversation, short enough that
// a leaked token expires quickly. The room dies when the visitor leaves
// regardless.
// Was 30 minutes, which is far longer than any demo needs and left a leaked token useful for half
// an hour. A demo running past 5 minutes is someone sitting on the line, not evaluating.
const TOKEN_TTL_SECONDS = 5 * 60;

// ── Abuse and capacity limits ─────────────────────────────────────────────────────────────────
// This endpoint is public and unauthenticated: anyone can mint a token and start a live voice call
// that costs LiveKit, Deepgram, LLM and TTS minutes. It had no rate limit, no concurrency ceiling
// and no duration cap — survivable while /demo was a link sent to individual prospects, but not
// once a "Talk to Leah" button sits on the homepage. The demo agent containers share a 2-vCPU box
// with the production portal and backend, so simultaneous demos compete for CPU with paying
// customers' portal sessions.
const DEMO_IP_MAX = 2;                       // demos per IP...
const DEMO_IP_WINDOW = 60 * 60 * 1000;       // ...per hour
const MAX_CONCURRENT_DEMOS = Number(process.env.DEMO_MAX_CONCURRENT || 2);
const MAX_DEMO_SECONDS = Number(process.env.DEMO_MAX_SECONDS || 300);

interface Bucket { count: number; windowStart: number; last: number }
const demosByIp = new Map<string, Bucket>();

/** Fixed-window counter. Returns seconds to wait if over the limit, else null. */
function hit(map: Map<string, Bucket>, key: string, max: number, windowMs: number): number | null {
  const now = Date.now();
  const b = map.get(key);
  if (!b || now - b.windowStart >= windowMs) {
    map.set(key, { count: 1, windowStart: now, last: now });
    return null;
  }
  b.last = now;
  if (b.count >= max) return Math.max(1, Math.ceil((b.windowStart + windowMs - now) / 1000));
  b.count += 1;
  return null;
}

function clientIp(req: Request): string {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket?.remoteAddress || 'unknown';
}

// Sweep hourly so the map can't grow without bound. unref() so it never holds the process open.
setInterval(() => {
  const cutoff = Date.now() - DEMO_IP_WINDOW;
  for (const [k, b] of demosByIp) if (b.last < cutoff) demosByIp.delete(k);
}, 60 * 60 * 1000).unref();

/**
 * How many demo rooms are live right now. Asks LiveKit rather than counting locally, so a visitor
 * who closes the tab frees their slot immediately instead of holding it for the full timeout.
 * Returns null if LiveKit can't be reached — the caller then allows the demo rather than blocking
 * every visitor because of an unrelated outage.
 */
async function liveDemoCount(httpUrl: string): Promise<number | null> {
  try {
    const rooms = await new RoomServiceClient(httpUrl, LIVEKIT_API_KEY, LIVEKIT_API_SECRET).listRooms();
    return rooms.filter((r) => r.name.startsWith('demo-')).length;
  } catch (err) {
    console.error('[demo] could not list rooms for the concurrency check:', err);
    return null;
  }
}

// Voices the demo agent can use — the /demo picker sends a key; we validate against this
// allowlist so a caller can't inject an arbitrary value into the dispatch metadata.
const DEMO_VOICES = new Set(['leah', 'tom', 'sophie', 'gemma', 'isobel', 'fraser']);
// Expressive Mode (LiveKit Agents >= 1.6.9) makes the LLM emit inline delivery tags the TTS
// renders. It only engages on a TTS that declares a markup dialect — ElevenLabs does NOT, so the
// expressive path swaps the voice engine too. Opt-in per call, so the public demo is unchanged.
// ElevenLabs is deliberately absent: no markup dialect, and our key cannot stream v3 at all
// (403 from the realtime websocket, tested 2026-08-12), so it would break the call.
const DEMO_EXPRESSIVE_TTS = new Set(['cartesia', 'inworld', 'fishaudio', 'xai']);

router.post('/livekit/demo-token', async (req: Request, res: Response) => {
  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    return res.status(503).json({ error: 'LiveKit not configured' });
  }

  const ip = clientIp(req);
  const ipWait = hit(demosByIp, ip, DEMO_IP_MAX, DEMO_IP_WINDOW);
  if (ipWait !== null) {
    console.warn(`[demo] rate-limited ip=${ip}`);
    res.setHeader('Retry-After', String(ipWait));
    return res.status(429).json({
      error: 'rate_limited', retryAfter: ipWait,
      message: "You've already tried the demo recently. Book a demo and we'll call you properly.",
    });
  }

  // Concurrency ceiling. Turn people away politely rather than letting everyone get a stuttering
  // call — and rather than starving the production portal on the same two cores.
  const httpUrlForCount = LIVEKIT_URL.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
  const live = await liveDemoCount(httpUrlForCount);
  if (live !== null && live >= MAX_CONCURRENT_DEMOS) {
    console.warn(`[demo] at capacity (${live}/${MAX_CONCURRENT_DEMOS}), turning away ip=${ip}`);
    return res.status(503).json({
      error: 'at_capacity',
      message: 'All demo lines are busy right now. Please try again in a few minutes, or book a demo and we will call you.',
    });
  }

  const requested = String(req.body?.voice ?? '').toLowerCase();
  const voice = DEMO_VOICES.has(requested) ? requested : 'leah';
  // Default to Inworld: Olivia is the only British voice among the four expressive engines, and
  // comparing a British agent against an American one tests accent rather than expression.
  const requestedTts = String(req.body?.tts ?? '').toLowerCase();
  const expressive = req.body?.expressive === true || req.body?.expressive === 'true';
  const tts = DEMO_EXPRESSIVE_TTS.has(requestedTts) ? requestedTts : 'inworld';

  const roomName = `demo-${randomBytes(8).toString('hex')}`;
  const identity = `visitor-${randomBytes(4).toString('hex')}`;

  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity,
    ttl: TOKEN_TTL_SECONDS,
  });
  at.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });
  at.metadata = JSON.stringify({ kind: 'web-demo' });

  const token = await at.toJwt();

  // Explicitly dispatch the demo agent into this room. The demo agent registers with an
  // agent_name ("demo-agent"), so it only joins rooms it's dispatched to — we can't rely on
  // auto-join. Best-effort: if dispatch hiccups we still return the token, but log loudly since
  // without the agent the room is silent.
  const httpUrl = LIVEKIT_URL.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
  // The self-hosted worker registers as 'demo-agent-v2' (see demo-agent/.env AGENT_DISPATCH_NAME),
  // so that is what has to be dispatched — a dispatch to 'demo-agent' names a worker that no
  // longer registers and the visitor waits in an empty room.
  //
  // ?agent=reg routes to the separate registration-specialist worker (demo-agent-reg, its own
  // container). Opt-in only: the public demo is unchanged and a visitor without the URL cannot
  // reach it.
  const wantsReg = String(req.body?.agent ?? '').toLowerCase() === 'reg';
  const agentName = wantsReg
    ? (process.env.DEMO_AGENT_NAME_REG || 'demo-agent-reg')
    : (process.env.DEMO_AGENT_NAME || 'demo-agent-v2');
  // Create the room explicitly so LiveKit enforces the guards server-side rather than relying on
  // the browser to hang up. maxParticipants=2 is the visitor plus the agent, so a shared room link
  // cannot turn into a conference. Best-effort: without it the room is still auto-created on join.
  const roomSvc = new RoomServiceClient(httpUrl, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
  try {
    await roomSvc.createRoom({
      name: roomName,
      emptyTimeout: 60,
      departureTimeout: 20,
      maxParticipants: 2,
    });
  } catch (err) {
    console.error(`[demo] could not pre-create ${roomName} with limits:`, err);
  }

  // Hard stop. Without this a visitor can hold a live voice call open indefinitely, burning
  // LiveKit, STT, LLM and TTS spend on one session. unref() so it never holds the process open.
  setTimeout(() => {
    roomSvc.deleteRoom(roomName).catch(() => {});
  }, MAX_DEMO_SECONDS * 1000).unref();

  try {
    const dispatchClient = new AgentDispatchClient(httpUrl, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
    await dispatchClient.createDispatch(roomName, agentName, {
      metadata: JSON.stringify({ kind: 'web-demo', voice, ...(expressive && { expressive: true, tts }) }),
    });
  } catch (err) {
    console.error(`[demo] failed to dispatch "${agentName}" into ${roomName}:`, err);
  }

  return res.json({
    token,
    url: LIVEKIT_URL,
    room: roomName,
    identity,
  });
});

// The self-hosted demo agent POSTs a finished demo conversation here on call end, so it appears
// in the portal. Auth is the same shared WEBHOOK_SECRET the production agents use for /calls —
// there's no user session. Deliberately minimal: no notifications, billing, or short-call skip.
router.post('/demo/call-log', async (req: Request, res: Response) => {
  const configuredSecret = process.env.WEBHOOK_SECRET;
  if (configuredSecret) {
    const provided = req.headers['x-webhook-secret'];
    if (provided !== configuredSecret) {
      return res.status(401).json({ error: 'Invalid webhook secret' });
    }
  }

  const b = (req.body ?? {}) as Record<string, unknown>;
  const transcript = Array.isArray(b.transcript) ? b.transcript : [];
  const asTrimmed = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() ? v.trim() : null;

  // Nothing worth logging if the visitor never actually spoke to the agent.
  if (transcript.length === 0) {
    return res.status(200).json({ success: true, skipped: 'empty transcript' });
  }

  const dur = Number(b.durationSeconds);
  try {
    const call = await prisma.call.create({
      data: {
        garageId: DEMO_GARAGE_ID,
        roomName: asTrimmed(b.roomName) ?? `demo-${randomBytes(4).toString('hex')}`,
        durationSeconds: Number.isFinite(dur) ? Math.max(0, Math.round(dur)) : 0,
        callType: asTrimmed(b.callType) ?? 'other',
        // Only accept an https S3 recording URL (the portal's audio endpoint serves these).
        recordingUrl: (() => { const u = asTrimmed(b.recordingUrl); return u && /^https:\/\/.*amazonaws\.com\//.test(u) ? u : null; })(),
        customerName: asTrimmed(b.customerName),
        registrationNumber: asTrimmed(b.registrationNumber),
        bookingDetails: asTrimmed(b.bookingDetails),
        confirmedBooking: Boolean(b.confirmedBooking),
        metrics: { demo: true, voice: asTrimmed(b.voice) ?? 'leah' } as Prisma.InputJsonValue,
        transcript: transcript as Prisma.InputJsonValue,
        summary: asTrimmed(b.summary) ?? 'Demo call',
      },
    });
    console.log(`[demo] logged demo call ${call.id} (room ${call.roomName})`);
    return res.status(201).json({ success: true, callId: call.id });
  } catch (err) {
    console.error('[demo] failed to log demo call:', err);
    return res.status(500).json({ error: 'Failed to log demo call' });
  }
});

export default router;
