// The agent reports a call that ended under 30 seconds; this decides whether to ring back.
//
// The agent deliberately makes no decision. It knows the duration and the caller's number —
// already cleaned of the forwarded-number case — and nothing else it needs to know. Everything
// about whether a callback is wanted lives here, where there is one copy of it rather than one
// per agent flavour.
import type { Request, Response } from 'express';
import { Router } from 'express';

import { prisma } from '../db.js';
import { isBlockedCaller } from '../utils/callerBlocklist.js';
import { isWithinOpeningHours } from '../utils/openingHours.js';
import { decideCallback } from '../services/callbackPolicy.js';

const router = Router();

/** Must match the agents' own MIN_LOG_SECONDS. A call at or over this is logged normally. */
const MIN_LOGGED_SECONDS = 30;
/** Let them redial us first — a caller who was cut off very often rings straight back. */
const DIAL_DELAY_MS = 60_000;
const GARAGE_DAILY_CAP = Number(process.env.SHORT_CALL_CALLBACK_GARAGE_CAP || 25);
const ESTATE_DAILY_CAP = Number(process.env.SHORT_CALL_CALLBACK_ESTATE_CAP || 150);
/** How far back "they rang us back themselves" looks. */
const RANG_BACK_WINDOW_MS = 60 * 60 * 1000;

/** The same webhook secret the agent already sends to POST /api/calls. */
const ensureWebhookSecret = (req: Request): boolean => {
  const configured = process.env.WEBHOOK_SECRET;
  if (!configured) return true;
  const header =
    req.headers['x-webhook-secret'] ?? req.headers['webhook-secret'] ?? req.headers['x-webhook_secret'];
  if (Array.isArray(header)) return header.includes(configured);
  return header === configured;
};

export const callbacksEnabled = (): boolean => process.env.SHORT_CALL_CALLBACK_ENABLED !== '0';

/**
 * The London calendar day, as "YYYY-MM-DD".
 *
 * Dedupe is per day rather than a rolling 24 hours so the database can enforce it with a unique
 * constraint. Check-then-write races two short calls arriving a second apart, which is exactly
 * what happens when somebody's signal drops twice.
 */
export function londonDayKey(at: Date): string {
  // en-CA renders as YYYY-MM-DD, which sorts and compares as a string.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

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

    const garage = await prisma.garage.findUnique({
      where: { id: report.garageId },
      select: {
        id: true,
        twilioNumber: true,
        agentConfiguration: {
          select: {
            shortCallCallback: true,
            weeklyOpeningHours: true,
            transferNumber: true,
            phoneNumber: true,
          },
        },
      },
    });
    if (!garage) return res.status(404).json({ error: 'Garage not found' });
    const config = garage.agentConfiguration;

    const [garageAttemptsToday, estateAttemptsToday, newerCall] = await Promise.all([
      prisma.callbackAttempt.count({
        where: { garageId: garage.id, dedupeKey: dayKey, status: { not: 'refused' } },
      }),
      prisma.callbackAttempt.count({ where: { dedupeKey: dayKey, status: { not: 'refused' } } }),
      report.callerPhone
        ? prisma.call.findFirst({
            where: {
              fromNumber: report.callerPhone,
              createdAt: { gte: new Date(now.getTime() - RANG_BACK_WINDOW_MS) },
            },
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);

    const decision = decideCallback({
      enabledGlobally: callbacksEnabled(),
      garageEnabled: config?.shortCallCallback === true,
      callerPhone: report.callerPhone,
      garageOwnNumbers: [garage.twilioNumber, config?.transferNumber, config?.phoneNumber],
      blocked: isBlockedCaller(report.callerPhone, garage.id),
      openNow: isWithinOpeningHours(config?.weeklyOpeningHours ?? null, now),
      // The room name carries the marker, so a callback is recognisable here even if the
      // agent-side guard were ever bypassed.
      originalWasCallback: (report.roomName ?? '').includes('_cb'),
      newerLoggedCallFromNumber: newerCall !== null,
      garageAttemptsToday,
      estateAttemptsToday,
      garageDailyCap: GARAGE_DAILY_CAP,
      estateDailyCap: ESTATE_DAILY_CAP,
    });

    // A refusal is recorded too. "Why did nobody get rung back?" is the first question anyone
    // asks, and the gate name is the answer.
    if (!decision.allow) {
      await prisma.callbackAttempt
        .create({
          data: {
            garageId: garage.id,
            toNumber: report.callerPhone ?? '',
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
          garageId: garage.id,
          toNumber: report.callerPhone as string,
          dedupeKey: dayKey,
          status: 'pending',
          originalCallSid: report.twilioCallSid,
          originalRoom: report.roomName,
          originalDurationSeconds: report.durationSeconds,
          dueAt: new Date(now.getTime() + DIAL_DELAY_MS),
        },
      });
      console.log(
        `[callback] queued ${attempt.id} for ${report.callerPhone} (${report.durationSeconds}s call)`,
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
