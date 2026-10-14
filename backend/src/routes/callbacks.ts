// The agent reports a call that ended under 30 seconds; this decides whether to ring back.
//
// The agent deliberately makes no decision. It knows the duration and the caller's number —
// already cleaned of the forwarded-number case — and nothing else it needs to know. Everything
// about whether a callback is wanted lives here, where there is one copy of it rather than one
// per agent flavour.
import type { Request, Response } from 'express';
import { Router } from 'express';

import { prisma } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { requestCallback } from '../services/callbackRequest.js';

export { londonDayKey } from '../services/callbackState.js';

const router = Router();

/** Must match the agents' own MIN_LOG_SECONDS. A call at or over this is logged normally. */
const MIN_LOGGED_SECONDS = 30;
/** Let them redial us first — a caller who was cut off very often rings straight back. */
const DIAL_DELAY_MS = 60_000;

/** The same webhook secret the agent already sends to POST /api/calls. */
const ensureWebhookSecret = (req: Request): boolean => {
  const configured = process.env.WEBHOOK_SECRET;
  if (!configured) return true;
  const header =
    req.headers['x-webhook-secret'] ?? req.headers['webhook-secret'] ?? req.headers['x-webhook_secret'];
  if (Array.isArray(header)) return header.includes(configured);
  return header === configured;
};

export type CallbackRequestBody = {
  garageId: string;
  callerPhone: string | null;
  durationSeconds: number;
  roomName: string | null;
  twilioCallSid: string | null;
};

export type ParseResult =
  | { ok: true; value: CallbackRequestBody }
  | { ok: false; error: string };

export function parseCallbackRequest(body: unknown): ParseResult {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body required' };
  const b = body as Record<string, unknown>;

  const garageId = typeof b.garageId === 'string' ? b.garageId.trim() : '';
  if (!garageId) return { ok: false, error: 'garageId required' };

  if (typeof b.durationSeconds !== 'number' || !Number.isFinite(b.durationSeconds)) {
    return { ok: false, error: 'durationSeconds must be a number' };
  }
  if (b.durationSeconds >= MIN_LOGGED_SECONDS || b.durationSeconds < 0) {
    return { ok: false, error: 'durationSeconds must be under 30' };
  }

  const str = (v: unknown): string | null => {
    const s = typeof v === 'string' ? v.trim() : '';
    return s === '' ? null : s;
  };

  return {
    ok: true,
    value: {
      garageId,
      callerPhone: str(b.callerPhone),
      durationSeconds: Math.floor(b.durationSeconds),
      roomName: str(b.roomName),
      twilioCallSid: str(b.twilioCallSid),
    },
  };
}

router.post('/callbacks/request', async (req: Request, res: Response) => {
  if (!ensureWebhookSecret(req)) return res.status(401).json({ error: 'Invalid webhook secret' });

  const parsed = parseCallbackRequest(req.body);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  try {
    // The agent's trigger. It catches one thing Twilio's cannot: a 30-44s call where the caller
    // never spoke, which does not reach the garage either. Everything else is caught by the
    // recording-status hook in voice.ts, because on a one-second hangup the agent never gets
    // far enough to report at all.
    const outcome = await requestCallback({ ...parsed.value, source: 'agent' });
    if (outcome.queued) return res.json({ queued: true, attemptId: outcome.attemptId });
    if (outcome.reason === 'garage_not_found') return res.status(404).json({ error: 'Garage not found' });
    return res.json({ queued: false, reason: outcome.reason });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'failed';
    console.error('[callback] request error:', msg);
    return res.status(500).json({ error: msg });
  }
});

// ---------------------------------------------------------------------------
// GET /api/callbacks?garageId=&limit= — what the feature has actually done.
//
// Staff only, and deliberately NOT garage-facing: a callback that failed must leave no trace a
// garage can see, which is the rule Dan set. This exists for the other half of that — without
// it there is no way to tell the feature is alive, or that it has started redialling the same
// number. The watchdog's single-garage blind spot and the support-hub ingest gap were both this
// shape: a thing that silently stopped, or silently ran, with nobody able to see which.
// ---------------------------------------------------------------------------
router.get('/callbacks', authenticate, async (req: Request, res: Response) => {
  if (req.user?.role !== 'RECEPTIONMATE_STAFF') return res.status(403).json({ error: 'Forbidden' });

  const garageId = String(req.query.garageId || '').trim();
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));

  try {
    const attempts = await prisma.callbackAttempt.findMany({
      where: garageId ? { garageId } : undefined,
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        garageId: true,
        toNumber: true,
        status: true,
        refusedReason: true,
        callerIdUsed: true,
        originalDurationSeconds: true,
        durationSeconds: true,
        resultRoom: true,
        createdAt: true,
        garage: { select: { name: true } },
      },
    });
    return res.json({ attempts });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'failed';
    console.error('[callback] list error:', msg);
    return res.status(500).json({ error: msg });
  }
});

export default router;
