// The agent reports a call that ended under 30 seconds; this decides whether to ring back.
//
// The agent deliberately makes no decision. It knows the duration and the caller's number —
// already cleaned of the forwarded-number case — and nothing else it needs to know. Everything
// about whether a callback is wanted lives here, where there is one copy of it rather than one
// per agent flavour.
import type { Request, Response } from 'express';
import { Router } from 'express';

import { prisma } from '../db.js';
import { decideCallback } from '../services/callbackPolicy.js';
import { loadCallbackPolicyInput, londonDayKey } from '../services/callbackState.js';

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
  const report = parsed.value;

  try {
    const now = new Date();
    const dayKey = londonDayKey(now);

    const state = await loadCallbackPolicyInput({
      garageId: report.garageId,
      callerPhone: report.callerPhone,
      originalRoom: report.roomName,
      now,
    });
    if (!state.found) return res.status(404).json({ error: 'Garage not found' });

    const decision = decideCallback(state.input);

    // A refusal is recorded too. "Why did nobody get rung back?" is the first question anyone
    // asks, and the gate name is the answer.
    if (!decision.allow) {
      await prisma.callbackAttempt
        .create({
          data: {
            garageId: report.garageId,
            toNumber: state.dialNumber ?? report.callerPhone ?? '',
            // Refusals must never consume the one-per-day slot a real callback needs, so they
            // are bucketed separately and can never collide with the unique index.
            dedupeKey: `refused:${dayKey}:${Math.random().toString(36).slice(2, 10)}`,
            status: 'refused',
            refusedReason: decision.reason,
            originalCallSid: report.twilioCallSid,
            originalRoom: report.roomName,
            originalDurationSeconds: report.durationSeconds,
            dueAt: now,
          },
        })
        .catch((e) => console.error('[callback] could not record refusal:', e?.message));
      return res.json({ queued: false, reason: decision.reason });
    }

    try {
      const attempt = await prisma.callbackAttempt.create({
        data: {
          garageId: report.garageId,
          // The CANONICAL number, not the raw report. What was validated is what gets dialled;
          // storing the raw string is how a SIP URI smuggled through the caller ID reached the
          // dialler as a destination.
          toNumber: state.dialNumber as string,
          dedupeKey: dayKey,
          status: 'pending',
          originalCallSid: report.twilioCallSid,
          originalRoom: report.roomName,
          originalDurationSeconds: report.durationSeconds,
          dueAt: new Date(now.getTime() + DIAL_DELAY_MS),
        },
      });
      console.log(
        `[callback] queued ${attempt.id} for ${state.dialNumber} (${report.durationSeconds}s call)`,
      );
      return res.json({ queued: true, attemptId: attempt.id });
    } catch (e: unknown) {
      // P2002 = the unique index. Another short call from this number today already queued a
      // callback; that is the dedupe working, not an error.
      if ((e as { code?: string })?.code === 'P2002') {
        return res.json({ queued: false, reason: 'already_queued_today' });
      }
      throw e;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'failed';
    console.error('[callback] request error:', msg);
    return res.status(500).json({ error: msg });
  }
});

export default router;
