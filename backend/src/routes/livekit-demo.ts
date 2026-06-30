// Mint a short-lived LiveKit access token for the public talking-avatar
// demo at /demo on the marketing site. The room name is randomised so each
// visitor gets their own avatar instance — the agent worker spawns a new
// agent per room automatically.

import type { Request, Response } from 'express';
import { Router } from 'express';
import { AccessToken } from 'livekit-server-sdk';
import { randomBytes } from 'crypto';

const router = Router();

const LIVEKIT_URL        = process.env.LIVEKIT_URL ?? '';
const LIVEKIT_API_KEY    = process.env.LIVEKIT_API_KEY ?? '';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET ?? '';

// Token TTL — long enough to cover a demo conversation, short enough that
// a leaked token expires quickly. The room dies when the visitor leaves
// regardless.
const TOKEN_TTL_SECONDS = 30 * 60;

router.post('/livekit/demo-token', async (_req: Request, res: Response) => {
  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    return res.status(503).json({ error: 'LiveKit not configured' });
  }

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
  // Optional: tell the dispatch system this room wants the avatar agent.
  // The agent worker can listen for this metadata to decide whether to
  // join this room (vs other rooms it's eligible for).
  at.metadata = JSON.stringify({ kind: 'avatar-demo' });

  const token = await at.toJwt();

  return res.json({
    token,
    url: LIVEKIT_URL,
    room: roomName,
    identity,
  });
});

export default router;
