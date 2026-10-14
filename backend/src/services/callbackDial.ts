// Placing the callback: a room, an agent dispatched into it, then the caller dialled in.
//
// The dial path is the one the unified agent already uses for warm transfers, so the trunk and
// its credentials are known to work in production. What is new is that WE create the room rather
// than an inbound trunk, so the agent must be dispatched EXPLICITLY — it is a named agent, and
// without an explicit dispatch the room is created and no worker ever joins.
//
// Explicit dispatch is also why this does not build a RoomConfiguration the way unifiedSip.ts
// does: the tree carries two copies of @livekit/protocol, so passing protocol objects across the
// SDK boundary does not typecheck. createDispatch takes a metadata string instead.
import { AgentDispatchClient, SipClient } from 'livekit-server-sdk';

import { prisma } from '../db.js';
import { canonicalDialNumber, decideCallback } from './callbackPolicy.js';
import { loadCallbackPolicyInput } from './callbackState.js';

const UNIFIED_AGENT_NAME = 'unified-agent';
/** Matches the transfer ring limit Dan set: past this, nobody is coming. */
const RING_SECONDS = 25;
/** The agents' own 10-minute cap, so a callback cannot run away either. */
const MAX_CALL_SECONDS = 600;
const SWEEP_BATCH = 10;

/**
 * Whether the outbound trunk will accept a per-call From.
 *
 * Only true for a trunk whose `numbers` is a wildcard, and that is not something to assume: a
 * trunk with a fixed number rejects a different From with SIP 403 Forbidden. Opt in explicitly
 * so a misconfiguration is a caller ID nobody chose rather than a call that does not happen.
 */
const trunkAcceptsAnyFrom = (): boolean => process.env.LIVEKIT_SIP_OUTBOUND_TRUNK_ANY_FROM === '1';

const config = () => {
  const url = process.env.LIVEKIT_UNIFIED_URL;
  const key = process.env.LIVEKIT_UNIFIED_API_KEY;
  const secret = process.env.LIVEKIT_UNIFIED_API_SECRET;
  const trunk = (
    process.env.LIVEKIT_SIP_OUTBOUND_TRUNK ||
    process.env.LIVEKIT_OUTBOUND_TRUNK_ID ||
    ''
  ).trim();
  return url && key && secret && trunk ? { url, key, secret, trunk } : null;
};

/**
 * E.164 digits only, or null.
 *
 * Garage.twilioNumber is stored for display — "+44 333 041 1784" — and no carrier presents it
 * that way. Passing it through verbatim is what put four malformed numbers on the demo line's
 * trunk, of which three had spaces in and none was the E.164 the INVITE actually carries.
 */
function e164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[^\d+]/g, '');
  return /^\+\d{10,15}$/.test(cleaned) ? cleaned : null;
}

/**
 * `garage-<id>_<caller>_cb<rand>`.
 *
 * The shape is the agent's: it parses the garage id and the caller's number straight out of the
 * room name. The marker sits AFTER the number, where neither of its regexes reaches, which this
 * module's tests pin.
 *
 * `_cbk_` is a segment of its own rather than a prefix on the random suffix, and that is the
 * whole point. An inbound room is `garage-<id>_<caller>_<rand>`, so a suffix beginning "cb"
 * would have read as a callback roughly one call in 1,300 — and the cost of that false positive
 * is greeting somebody who has just rung in with "we've just missed a call from you". A caller
 * number is digits, so no inbound room can contain `_cbk_` at all.
 */
/**
 * How late a callback may be placed before it is no longer worth placing. Fifteen minutes.
 *
 * The sweep had no lower bound, so an outage — the memory leak, a DB OOM, a long deploy — meant
 * every row queued yesterday afternoon dialled the next morning, telling each customer "we've
 * just missed a call from you" about a call from the previous day. The dial-time policy re-check
 * does not catch that: by nine the next morning the garage is open again.
 */
export const MAX_ATTEMPT_AGE_MS = 15 * 60 * 1000;

export function isStaleAttempt(dueAt: Date, now: Date): boolean {
  return now.getTime() - dueAt.getTime() > MAX_ATTEMPT_AGE_MS;
}

/**
 * Was this failure OURS rather than "nobody answered"?
 *
 * It decides whether the caller keeps their one callback for the day. A ring-out is a real,
 * spent attempt and nobody should be rung twice over one dropped call. A 403 from the carrier is
 * not: it means our trunk, credentials or caller ID are wrong, nobody's phone ever rang, and
 * holding the slot punishes the customer for our misconfiguration. That is exactly what happened
 * on the first live callback — a trunk built with a masked password, recorded as "no_answer",
 * and the number locked out for the rest of the day.
 *
 * Anything unrecognised counts as theirs, so "one attempt" still means one. Erring the other way
 * would retry on any failure we could not classify, which is how somebody gets rung repeatedly.
 */
export function isOurFailure(message: string): boolean {
  const m = (message || '').toLowerCase();
  if (m.includes('no trunk') || m.includes('not configured')) return true;
  // Authorisation and server faults: the call was refused before it could ring.
  return /\b(401|403|407|500|502|503|504)\b/.test(m);
}

export function callbackRoomName(garageId: string, toNumber: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `garage-${garageId}_${toNumber}_cbk_${rand}`;
}

/** Which number to present. Most garages are unverified, so the fallback is the common path. */
export function callerIdFor(garage: {
  outboundCallerId: string | null;
  outboundCallerIdVerified: boolean;
  twilioNumber: string | null;
}): string | null {
  if (garage.outboundCallerIdVerified) {
    const verified = e164(garage.outboundCallerId);
    if (verified) return verified;
  }
  return e164(garage.twilioNumber);
}

export async function dialCallback(attemptId: string): Promise<void> {
  const cfg = config();
  const attempt = await prisma.callbackAttempt.findUnique({
    where: { id: attemptId },
    include: {
      garage: {
        select: {
          id: true,
          name: true,
          twilioNumber: true,
          outboundCallerId: true,
          outboundCallerIdVerified: true,
        },
      },
    },
  });
  // Only ever dial a row still waiting to be dialled. This is what stops a sweep that overlaps
  // its predecessor ringing the same person twice.
  if (!attempt || attempt.status !== 'pending') return;

  // A failure that is OURS — no trunk configured, no caller ID — must not consume the caller's
  // one callback for the day. The dedupeKey is what the unique index enforces, so it is moved
  // aside; fix the env var at 11am and the morning's callers can still be rung.
  const fail = (reason: string) =>
    prisma.callbackAttempt.update({
      where: { id: attempt.id },
      data: {
        status: 'failed',
        refusedReason: reason,
        dedupeKey: `failed:${attempt.dedupeKey}:${Math.random().toString(36).slice(2, 10)}`,
      },
    });

  if (!cfg) {
    console.warn('[callback] LIVEKIT_UNIFIED_* or the outbound trunk is not configured — not dialling');
    await fail('not_configured');
    return;
  }

  // ── Check the policy AGAIN, here, at the moment of spend ──────────────────────────────────
  //
  // The attempt was authorised when the short call ended and is being dialled at least 60
  // seconds later. In between, the garage may have been archived, locked for arrears, had the
  // flag switched off, or the kill switch thrown — and the queued row knows none of it. Without
  // this the row's own existence is the authorisation, which fails open.
  //
  // It is also the authoritative cap check. The endpoint counts, decides and inserts across
  // two awaits, so concurrent reports all read the same count and all pass, and the unique
  // index only stops the same number twice. This sweep is serialised, so the count taken here
  // is the real one, and this is the last gate before money is spent.
  //
  // Re-canonicalised rather than trusted: the stored number should already be canonical, but
  // the thing being handed to SIP must be the thing that was just validated, not a value read
  // back from a row that some other code path might have written.
  const dialNumber = canonicalDialNumber(attempt.toNumber);
  if (!dialNumber) {
    console.warn(`[callback] ${attempt.toNumber} is not a number we will dial — refusing`);
    await fail('not_dialable_range');
    return;
  }

  const state = await loadCallbackPolicyInput({
    garageId: attempt.garageId,
    callerPhone: attempt.toNumber,
    originalRoom: attempt.originalRoom,
    now: new Date(),
    // The window this gate is actually about: did they ring back while we waited?
    rangBackSince: attempt.createdAt,
  });
  if (!state.found) {
    await fail('garage_gone');
    return;
  }
  // The caps counted this pending row itself, so allow for it rather than refusing every
  // attempt the moment one is queued.
  const recheck = decideCallback({
    ...state.input,
    garageAttemptsToday: Math.max(0, state.input.garageAttemptsToday - 1),
    estateAttemptsToday: Math.max(0, state.input.estateAttemptsToday - 1),
  });
  if (!recheck.allow) {
    console.log(`[callback] ${attempt.toNumber} no longer eligible at dial time — ${recheck.reason}`);
    await prisma.callbackAttempt.update({
      where: { id: attempt.id },
      data: { status: 'refused', refusedReason: `at_dial:${recheck.reason}` },
    });
    return;
  }

  // Only send a From when the trunk takes one. Otherwise the trunk's own number is presented,
  // which is a ReceptionMate number rather than the garage's — and for 61 of 63 garages that is
  // what would be presented anyway, since only two have a verified caller ID.
  const fromNumber = trunkAcceptsAnyFrom() ? callerIdFor(attempt.garage) : null;
  if (trunkAcceptsAnyFrom() && !fromNumber) {
    await fail('no_caller_id');
    return;
  }

  const room = callbackRoomName(attempt.garageId, dialNumber);

  // Marked dialled BEFORE the dial, not after. The attempt is spent the moment the phone starts
  // ringing, so that is where it is recorded — on every path out of here, including exceptions
  // nobody anticipated. Recording it afterwards would let a crash mid-dial leave the row pending
  // for the next sweep to pick up, and ring the customer a second time.
  await prisma.callbackAttempt.update({
    where: { id: attempt.id },
    data: { status: 'dialled', callerIdUsed: fromNumber ?? 'trunk default', resultRoom: room },
  });

  try {
    // Dispatch first, so a worker is already on its way before the phone rings and the caller
    // does not answer to silence.
    const dispatch = new AgentDispatchClient(cfg.url, cfg.key, cfg.secret);
    await dispatch.createDispatch(room, UNIFIED_AGENT_NAME, {
      metadata: JSON.stringify({ callback: true, to: dialNumber, garageId: attempt.garageId }),
    });

    const sip = new SipClient(cfg.url, cfg.key, cfg.secret);
    await sip.createSipParticipant(cfg.trunk, dialNumber, room, {
      // Omitted entirely when the trunk has a fixed number: passing a From it does not own is
      // what Twilio answers with 403 Forbidden.
      ...(fromNumber ? { fromNumber } : {}),
      participantIdentity: `sip_${dialNumber}`,
      participantName: 'Callback recipient',
      playDialtone: false,
      ringingTimeout: RING_SECONDS,
      maxCallDuration: MAX_CALL_SECONDS,
      waitUntilAnswered: true,
    });

    await prisma.callbackAttempt.update({ where: { id: attempt.id }, data: { status: 'answered' } });
    console.log(`[callback] ${attempt.garage.name}: ${dialNumber} answered (room ${room})`);
  } catch (err: unknown) {
    // A ring-out raises here too, and is the ordinary outcome rather than a bug. One attempt
    // only: nobody is rung twice over one dropped call.
    const msg = err instanceof Error ? err.message : 'dial failed';
    const ours = isOurFailure(msg);
    console.log(
      `[callback] ${attempt.garage.name}: ${dialNumber} did not connect — ${msg} ` +
        `(${ours ? 'our fault, slot released' : 'no answer, attempt spent'})`,
    );
    await prisma.callbackAttempt.update({
      where: { id: attempt.id },
      data: {
        status: ours ? 'failed' : 'no_answer',
        refusedReason: msg.slice(0, 200),
        // Only a failure that is ours releases the number's slot for the day. A genuine
        // ring-out keeps it, because that attempt was really spent.
        ...(ours
          ? { dedupeKey: `failed:${attempt.dedupeKey}:${Math.random().toString(36).slice(2, 10)}` }
          : {}),
      },
    });
  }
}

let timer: NodeJS.Timeout | null = null;
let running = false;

/**
 * Dial whatever has come due.
 *
 * A sweep rather than a setTimeout per attempt, so a restart inside the delay does not silently
 * lose the callback. The interval has to be well under DIAL_DELAY_MS or the delay is a fiction:
 * at a 30s interval a "20 second" wait was really 20-50s. `running` guards against a slow batch overlapping the next tick:
 * createSipParticipant waits for an answer, so one batch can easily outlast the interval.
 */
export function startCallbackSweep(intervalMs = 10_000): void {
  if (timer) return;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const now = new Date();
      // Abandon anything the staleness window has passed rather than dialling it late. Done as
      // one update so a backlog is cleared in a single statement rather than row by row.
      const expired = await prisma.callbackAttempt.updateMany({
        where: { status: 'pending', dueAt: { lt: new Date(now.getTime() - MAX_ATTEMPT_AGE_MS) } },
        data: { status: 'refused', refusedReason: 'too_late' },
      });
      if (expired.count) {
        console.log(`[callback] abandoned ${expired.count} attempt(s) too old to place`);
      }

      const due = await prisma.callbackAttempt.findMany({
        where: { status: 'pending', dueAt: { lte: now } },
        // Oldest first, so a backlog drains in the order people rang rather than arbitrarily.
        orderBy: { dueAt: 'asc' },
        select: { id: true },
        take: SWEEP_BATCH,
      });
      for (const { id } of due) {
        // Per row. dialCallback's own try/catch covers the dial, but not the reads and writes
        // around it — and an exception there would abort the batch, leave the rest pending, and
        // with the same rows coming back next tick a reliably-throwing row would wedge the queue
        // for good, behind nothing but a repeating log line.
        try {
          await dialCallback(id);
        } catch (e: unknown) {
          console.error(`[callback] attempt ${id} threw:`, e instanceof Error ? e.message : e);
          await prisma.callbackAttempt
            .update({ where: { id }, data: { status: 'failed', refusedReason: 'threw' } })
            .catch(() => {});
        }
      }
    } catch (e: unknown) {
      console.error('[callback] sweep error:', e instanceof Error ? e.message : e);
    } finally {
      running = false;
    }
  };
  timer = setInterval(() => void run(), intervalMs);
  // The config is static, so this is knowable now rather than on the first attempt. The trunk
  // env var is new to the PORTAL — the name comes from the agent's environment — so the box can
  // easily be missing it, and without this the only symptom is a day of attempts quietly
  // failing behind one console.warn.
  if (!config()) {
    console.warn(
      '[callback] NOT READY: set LIVEKIT_UNIFIED_URL/API_KEY/API_SECRET and ' +
        'LIVEKIT_SIP_OUTBOUND_TRUNK (the trunk must be in the UNIFIED project). ' +
        'Callbacks will be queued and then fail until this is set.',
    );
  }
  console.log(`[callback] sweep started (every ${Math.round(intervalMs / 1000)}s)`);
}
