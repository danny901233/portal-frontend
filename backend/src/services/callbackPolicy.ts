// Whether to ring a caller back after a call that ended under 30 seconds.
//
// Pure on purpose. Every gate here is a condition that has either cost this estate money or
// could ring a customer who does not want ringing, and a pure function is the only version of
// this that can be tested exhaustively without a database or a phone line. The caller gathers
// the state; this decides.
//
// One place, not seven. The same reasoning as the WhatsApp sender's safety rules: a policy
// copied into each agent flavour drifts, and the drift is silent.
import { isWithheldCaller, normaliseCaller } from '../utils/callerBlocklist.js';

export type CallbackRefusal =
  | 'kill_switch'
  | 'flag_off'
  | 'no_number'
  | 'withheld'
  | 'garage_own_number'
  | 'not_dialable_range'
  | 'blocklisted'
  | 'closed'
  | 'called_back_already'
  | 'was_callback'
  | 'garage_cap'
  | 'estate_cap';

export type CallbackDecision = { allow: true } | { allow: false; reason: CallbackRefusal };

export type CallbackPolicyInput = {
  /** SHORT_CALL_CALLBACK_ENABLED. False disables dialling estate-wide. */
  enabledGlobally: boolean;
  /** AgentConfiguration.shortCallCallback for this garage. */
  garageEnabled: boolean;
  /** The caller's number as the agent resolved it, or null if it had none. */
  callerPhone: string | null;
  /** The garage's own lines: twilioNumber, transferNumber, phoneNumber. */
  garageOwnNumbers: (string | null | undefined)[];
  /** isBlockedCaller() for this number on this line. */
  blocked: boolean;
  /** isWithinOpeningHours() for this garage, now. */
  openNow: boolean;
  /** Was the call that ended short itself a callback we placed? */
  originalWasCallback: boolean;
  /** Has a Call been logged from this number since the short one? */
  newerLoggedCallFromNumber: boolean;
  garageAttemptsToday: number;
  estateAttemptsToday: number;
  garageDailyCap: number;
  estateDailyCap: number;
};

/**
 * Comparable digits for matching one number against another.
 *
 * normaliseCaller already puts an 11-digit UK national number into international form; this adds
 * the 10-digit case it leaves alone, so "0203149102" and "44203149102" still match.
 */
function comparableDigits(raw: string): string {
  const digits = normaliseCaller(raw);
  if (digits.startsWith('0') && digits.length >= 10) return `44${digits.slice(1)}`;
  return digits;
}

/**
 * Numbers this feature is willing to ring: UK landlines, 03 numbers, and real mobiles.
 *
 * ── Why an allow-list and not a block-list ──────────────────────────────────────────────────
 * This is the first thing in the estate that dials a number a stranger chose. Caller ID is
 * trivially spoofed, so the number is attacker-controlled input: ring the garage, present a
 * premium-rate or satellite number, hang up after five seconds, and we call it back and keep an
 * agent on the line for up to MAX_CALL_SECONDS. The per-number daily cap is no defence — vary
 * the number and the estate cap still permits 150 calls a day.
 *
 *   44 1 / 44 2    geographic landlines
 *   44 3           03xx, charged as geographic
 *   44 7[1-5,7-9]  mobiles
 *
 * Everything else is refused, and the exclusions are the point:
 *   09  premium rate          08  freephone and revenue share
 *   070 personal numbering — the classic toll-fraud range, because at a glance it reads as a
 *       mobile and it is billed nothing like one
 *   076 pagers
 *   any non-UK number, satellite ranges among them
 *
 * A UK customer ringing from abroad therefore gets no callback. That is the right side to err
 * on: they can ring again, and the alternative is an open line to any destination on earth.
 */
const UK_DIALABLE = /^44(?:[123]\d{9}|7[1-57-9]\d{8})$/;

export function decideCallback(input: CallbackPolicyInput): CallbackDecision {
  // Order matters. The reason recorded on the row is the FIRST gate that said no, and the kill
  // switch being reported ahead of everything else is what makes "why has nothing dialled all
  // morning?" answerable in one look.
  if (!input.enabledGlobally) return { allow: false, reason: 'kill_switch' };
  if (!input.garageEnabled) return { allow: false, reason: 'flag_off' };

  // Before the number is trusted at all: a callback we placed must never beget another. Most
  // callbacks end under 30 seconds — no answer, voicemail, "no thanks" — so without this the
  // feature redials the same person until a cap stops it. Checked here, ahead of the number,
  // so a loop is what gets named on the row even when the number is also unusable.
  if (input.originalWasCallback) return { allow: false, reason: 'was_callback' };

  const raw = (input.callerPhone ?? '').trim();
  if (!raw) return { allow: false, reason: 'no_number' };
  // Covers "anonymous", Twilio's 266696687 keypad sentinel, and anything under 7 digits.
  if (isWithheldCaller(raw)) return { allow: false, reason: 'withheld' };

  const caller = comparableDigits(raw);
  if (caller.length < 10) return { allow: false, reason: 'no_number' };

  // Ahead of the caps, so a spoofed premium number cannot spend one of the day's attempts.
  if (!UK_DIALABLE.test(caller)) return { allow: false, reason: 'not_dialable_range' };

  // The garage's own line. Their carrier presents the FORWARDING number on a diverted call, so a
  // whole day's callers can arrive as the garage's own landline — and ringing that back reaches
  // the garage, repeatedly. The agent strips this case too; this is the second line of defence.
  //
  // Short and blank entries are dropped rather than compared: an unset transferNumber must not
  // make every caller look like the garage itself.
  const own = new Set(
    input.garageOwnNumbers
      .filter((n): n is string => typeof n === 'string' && n.trim() !== '')
      .map(comparableDigits)
      .filter((n) => n.length >= 10),
  );
  if (own.has(caller)) return { allow: false, reason: 'garage_own_number' };

  if (input.blocked) return { allow: false, reason: 'blocklisted' };
  if (!input.openNow) return { allow: false, reason: 'closed' };
  if (input.newerLoggedCallFromNumber) return { allow: false, reason: 'called_back_already' };

  if (input.garageAttemptsToday >= input.garageDailyCap) return { allow: false, reason: 'garage_cap' };
  if (input.estateAttemptsToday >= input.estateDailyCap) return { allow: false, reason: 'estate_cap' };

  return { allow: true };
}
