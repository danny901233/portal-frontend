// Requesting a callback for a call that ended short — one path, two callers.
//
// ── Why this is not just the agent's job ────────────────────────────────────────────────────
// It began as an agent-only report: the agent noticed a short call on shutdown and told the
// portal. That cannot work for the calls this feature exists for. On a one- or two-second
// hangup the room empties before the agent's job is really running, so no shutdown runs and no
// report is ever sent — proved live on 2026-10-14, eight consecutive test calls of 1-6 seconds
// producing zero reports.
//
// And those are the majority: of 1,246 sub-30s calls in a fortnight, 619 were five seconds or
// less. Dan's decision is that those get a callback too.
//
// So the authoritative trigger is Twilio's recording-status callback, which fires with the real
// line duration for every answered call however briefly it lasted. The agent's report stays as
// a second trigger, because it catches one thing Twilio cannot see: a 30-44s call where the
// caller never spoke, which does not reach the garage either. The per-day unique index means
// both firing for one call is harmless.
import { prisma } from '../db.js';

import { decideCallback } from './callbackPolicy.js';
import { loadCallbackPolicyInput, londonDayKey } from './callbackState.js';

/**
 * How long to wait before dialling. 20 seconds, set by Dan 2026-10-14 (was 60).
 *
 * It exists so a caller who was cut off and is already redialling us is not dialled into an
 * engaged tone, spending the one attempt for nothing. 20s keeps that while making the callback
 * feel like a response to the dropped call rather than an unexplained call a minute later.
 */
const DIAL_DELAY_MS = 20_000;

export type ShortCallReport = {
  garageId: string;
  callerPhone: string | null;
  twilioCallSid: string | null;
  roomName: string | null;
  durationSeconds: number;
  /** Which trigger noticed, for the admin trail. */
  source: 'agent' | 'twilio';
};

export type RequestOutcome =
  | { queued: true; attemptId: string }
  | { queued: false; reason: string };

export async function requestCallback(report: ShortCallReport): Promise<RequestOutcome> {
  const now = new Date();
  const dayKey = londonDayKey(now);

  const state = await loadCallbackPolicyInput({
    garageId: report.garageId,
    callerPhone: report.callerPhone,
    originalRoom: report.roomName,
    now,
    // Nothing can have happened yet — the short call has only just ended.
    rangBackSince: now,
  });
  if (!state.found) return { queued: false, reason: 'garage_not_found' };

  const decision = decideCallback(state.input);

  // A refusal is recorded too. "Why did nobody get rung back?" is the first question anyone
  // asks, and the gate name is the answer.
  if (!decision.allow) {
    await prisma.callbackAttempt
      .create({
        data: {
          garageId: report.garageId,
          toNumber: state.dialNumber ?? report.callerPhone ?? '',
          // Refusals must never occupy the one-per-day slot a real callback needs, so they are
          // bucketed separately and can never collide with the unique index.
          dedupeKey: `refused:${dayKey}:${Math.random().toString(36).slice(2, 10)}`,
          status: 'refused',
          refusedReason: `${report.source}:${decision.reason}`,
          originalCallSid: report.twilioCallSid,
          originalRoom: report.roomName,
          originalDurationSeconds: report.durationSeconds,
          dueAt: now,
        },
      })
      .catch((e) => console.error('[callback] could not record refusal:', e?.message));
    console.log(
      `[callback] refused (${report.source}) ${report.callerPhone} on ${report.garageId}: ${decision.reason}`,
    );
    return { queued: false, reason: decision.reason };
  }

  try {
    const attempt = await prisma.callbackAttempt.create({
      data: {
        garageId: report.garageId,
        // The CANONICAL number, not the raw report. What was validated is what gets dialled;
        // storing the raw string is how a SIP URI smuggled through the caller ID would reach
        // the dialler as a destination.
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
      `[callback] queued ${attempt.id} (${report.source}) for ${state.dialNumber} ` +
        `after a ${report.durationSeconds}s call`,
    );
    return { queued: true, attemptId: attempt.id };
  } catch (e: unknown) {
    // P2002 = the unique index. Another short call from this number today already queued one —
    // which is the dedupe working rather than an error, and is exactly what happens when both
    // triggers see the same call.
    if ((e as { code?: string })?.code === 'P2002') {
      // Logged, because this path being silent is what made a whole evening of test calls look
      // like the trigger was dead when it was in fact firing every time and being deduped.
      console.log(
        `[callback] not queued (${report.source}) ${state.dialNumber}: already has a callback today`,
      );
      return { queued: false, reason: 'already_queued_today' };
    }
    throw e;
  }
}
