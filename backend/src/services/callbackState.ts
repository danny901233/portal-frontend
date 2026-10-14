// Gathering the state the callback policy needs, in one place, for both of its call sites.
//
// The policy is checked TWICE: once when the short call is reported, and again by the sweep at
// the moment of dialling. Those two moments are at least 60 seconds apart, and in between the
// garage can have been archived, locked for arrears, had the flag turned off, or the kill switch
// thrown — none of which the queued row knows about. Re-reading is the only thing that closes
// that window, and re-reading is only safe if both checks see state assembled the same way.
//
// It also closes a cap bypass. The endpoint counts, decides and inserts across two awaits, so
// concurrent reports all read the same count and all pass; the unique index only stops the same
// number twice, so varying the number walks through the estate cap. The sweep is serialised, so
// the count it takes here is the authoritative one, and it is the last gate before money is
// spent.
import { prisma } from '../db.js';
import { isBlockedCaller } from '../utils/callerBlocklist.js';
import { isWithinOpeningHours } from '../utils/openingHours.js';

import { canonicalDialNumber, type CallbackPolicyInput } from './callbackPolicy.js';

const GARAGE_DAILY_CAP = Number(process.env.SHORT_CALL_CALLBACK_GARAGE_CAP || 25);
const ESTATE_DAILY_CAP = Number(process.env.SHORT_CALL_CALLBACK_ESTATE_CAP || 150);

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

export type LoadedState =
  | { found: false }
  | { found: true; input: CallbackPolicyInput; dialNumber: string | null };

export async function loadCallbackPolicyInput(args: {
  garageId: string;
  callerPhone: string | null;
  originalRoom: string | null;
  now: Date;
  /**
   * Only a logged call AFTER this instant counts as "they rang back themselves".
   *
   * It used to be a flat hour backwards from now, which counted calls that happened BEFORE the
   * short one — and those say nothing about whether the short one needs chasing. It refused a
   * live test on 2026-10-14 because of a longer call from the same number four minutes earlier.
   *
   * At queue time this is simply now, since nothing can have happened yet. At dial time it is
   * when the attempt was queued, which is the window the question is actually about: did they
   * ring back during the 60 seconds we waited?
   */
  rangBackSince: Date;
}): Promise<LoadedState> {
  const { garageId, callerPhone, originalRoom, now, rangBackSince } = args;
  const dayKey = londonDayKey(now);

  const garage = await prisma.garage.findUnique({
    where: { id: garageId },
    select: {
      id: true,
      twilioNumber: true,
      archivedAt: true,
      accessRestricted: true,
      hasVoiceAccess: true,
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
  if (!garage) return { found: false };
  const config = garage.agentConfiguration;

  const countWhere = { dedupeKey: dayKey, status: { not: 'refused' } };
  const [garageAttemptsToday, estateAttemptsToday, newerCall] = await Promise.all([
    prisma.callbackAttempt.count({ where: { garageId: garage.id, ...countWhere } }),
    prisma.callbackAttempt.count({ where: countWhere }),
    callerPhone
      ? prisma.call.findFirst({
          // Scoped to this garage too: a call they made to a DIFFERENT garage is not them
          // ringing this one back.
          where: { fromNumber: callerPhone, garageId: garage.id, createdAt: { gt: rangBackSince } },
          select: { id: true },
        })
      : Promise.resolve(null),
  ]);

  return {
    found: true,
    dialNumber: canonicalDialNumber(callerPhone),
    input: {
      enabledGlobally: callbacksEnabled(),
      garageEnabled: config?.shortCallCallback === true,
      // Archived, locked for arrears, or voice switched off: all three mean this garage should
      // not be placing calls in its own name.
      garageActive:
        garage.archivedAt === null && garage.accessRestricted !== true && garage.hasVoiceAccess !== false,
      callerPhone,
      garageOwnNumbers: [garage.twilioNumber, config?.transferNumber, config?.phoneNumber],
      blocked: isBlockedCaller(callerPhone, garage.id),
      openNow: isWithinOpeningHours(config?.weeklyOpeningHours ?? null, now),
      // The room name carries the marker, so a callback is recognisable here even if the
      // agent-side guard were ever bypassed.
      originalWasCallback: (originalRoom ?? '').includes('_cbk_'),
      newerLoggedCallFromNumber: newerCall !== null,
      garageAttemptsToday,
      estateAttemptsToday,
      garageDailyCap: GARAGE_DAILY_CAP,
      estateDailyCap: ESTATE_DAILY_CAP,
    },
  };
}
