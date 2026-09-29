/**
 * Proving who is on the phone to support.
 *
 * The support agent needs to know which garage it is talking to before it can
 * be any use — and must not take their word for it, because a garage name is
 * not a secret. Two ways in:
 *
 *   1. The number they are calling from matches the main contact number on
 *      their own Company information page. We already hold it, they did not
 *      have to remember anything, and it is theirs.
 *   2. Otherwise, five digits shown to them in the portal, read out.
 *
 * Both unlock READING their own data and nothing more. Five digits spoken down
 * a phone is a weak secret and caller ID can be spoofed, so neither is allowed
 * to change anything: where the agent would have made a change it raises a
 * ticket saying what it would have done, and a person does it.
 */
import { prisma } from '../db.js';
import { randomInt } from 'crypto';

/** Reduce a number to its digits, and drop the UK country code, so
 *  +447700900123, 07700900123 and 447700900123 all compare equal. */
export function normaliseNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('44')) return `0${digits.slice(2)}`;
  if (digits.startsWith('0')) return digits;
  return digits;
}

export interface Identified {
  garageId: string;
  garageName: string;
  /** How we know: the number they rang from, or the code they read out. */
  via: 'caller_number' | 'support_code';
}

/** Whoever owns this number, if we hold it as their main contact number. */
export async function identifyByCallerNumber(callerNumber: string | null | undefined): Promise<Identified | null> {
  const wanted = normaliseNumber(callerNumber);
  if (!wanted) return null;
  // The number lives on the agent configuration, free-typed, so it is stored in
  // whatever shape the garage entered. Normalise both sides rather than trust
  // the format.
  const configs = await prisma.agentConfiguration.findMany({
    where: { phoneNumber: { not: null } },
    select: { garageId: true, phoneNumber: true },
  });
  const match = configs.find((c) => normaliseNumber(c.phoneNumber) === wanted);
  if (!match) return null;
  const garage = await prisma.garage.findUnique({
    where: { id: match.garageId },
    select: { id: true, name: true },
  });
  if (!garage) return null;
  return { garageId: garage.id, garageName: garage.name, via: 'caller_number' };
}

// ── Guessing the code ───────────────────────────────────────────────────────
// Five digits is a hundred thousand combinations: ample against somebody
// chancing it on a call, useless against somebody patient. Failures are counted
// per calling number, in memory — a restart forgives them, which is the right
// trade for something that must never lock a real customer out for long.
const MAX_FAILURES = 5;
const WINDOW_MS = 60 * 60 * 1000;
const failures = new Map<string, { count: number; first: number }>();

export function tooManyAttempts(callerNumber: string | null | undefined): boolean {
  const key = normaliseNumber(callerNumber) ?? 'unknown';
  const rec = failures.get(key);
  if (!rec) return false;
  if (Date.now() - rec.first > WINDOW_MS) { failures.delete(key); return false; }
  return rec.count >= MAX_FAILURES;
}

function recordFailure(callerNumber: string | null | undefined): void {
  const key = normaliseNumber(callerNumber) ?? 'unknown';
  const rec = failures.get(key);
  if (!rec || Date.now() - rec.first > WINDOW_MS) failures.set(key, { count: 1, first: Date.now() });
  else rec.count += 1;
}

/** Whoever this code belongs to. Wrong codes are counted against the caller. */
export async function identifyBySupportCode(
  code: string | null | undefined,
  callerNumber?: string | null,
): Promise<Identified | null> {
  const digits = (code ?? '').replace(/\D/g, '');
  if (digits.length !== 5) { recordFailure(callerNumber); return null; }
  const garage = await prisma.garage.findUnique({
    where: { supportCode: digits },
    select: { id: true, name: true },
  });
  if (!garage) { recordFailure(callerNumber); return null; }
  return { garageId: garage.id, garageName: garage.name, via: 'support_code' };
}

/**
 * This garage's code, minting one the first time it is asked for.
 *
 * Generated rather than derived from anything about the garage, so it gives
 * nothing away, and re-drawn on the astronomically unlikely collision.
 */
export async function getOrCreateSupportCode(garageId: string): Promise<string> {
  const existing = await prisma.garage.findUnique({
    where: { id: garageId },
    select: { supportCode: true },
  });
  if (existing?.supportCode) return existing.supportCode;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    // 10000-99999: never starts with a zero, because a leading zero is the
    // thing people drop when reading a number aloud.
    const code = String(randomInt(10000, 100000));
    try {
      await prisma.garage.update({ where: { id: garageId }, data: { supportCode: code } });
      return code;
    } catch {
      // Taken. Draw again.
    }
  }
  throw new Error(`could not allocate a support code for ${garageId}`);
}
