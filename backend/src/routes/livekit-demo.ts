// Mint a short-lived LiveKit access token for the public talking-avatar
// demo at /demo on the marketing site. The room name is randomised so each
// visitor gets their own avatar instance — the agent worker spawns a new
// agent per room automatically.

import type { Request, Response } from 'express';
import type { Prisma } from '@prisma/client';
import { Router } from 'express';
import { AccessToken, AgentDispatchClient } from 'livekit-server-sdk';
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
const TOKEN_TTL_SECONDS = 30 * 60;

// Voices the demo agent can use — the /demo picker sends a key; we validate against this
// allowlist so a caller can't inject an arbitrary value into the dispatch metadata.
const DEMO_VOICES = new Set(['leah', 'tom', 'sophie', 'gemma', 'isobel', 'fraser']);

router.post('/livekit/demo-token', async (req: Request, res: Response) => {
  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    return res.status(503).json({ error: 'LiveKit not configured' });
  }

  const requested = String(req.body?.voice ?? '').toLowerCase();
  const voice = DEMO_VOICES.has(requested) ? requested : 'leah';

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
  const agentName = process.env.DEMO_AGENT_NAME || 'demo-agent';
  try {
    const dispatchClient = new AgentDispatchClient(httpUrl, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
    await dispatchClient.createDispatch(roomName, agentName, {
      metadata: JSON.stringify({ kind: 'web-demo', voice }),
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
