/**
 * Telling "we never learned this caller's number" apart from "there was no call".
 *
 * Advanced Service Centre reported a call showing their own transfer line as the
 * caller (45674754). The number is now dropped server-side rather than stored,
 * which is correct but leaves a blank — and a blank reads as missing data, so
 * staff still try to ring back. Say what actually happened instead.
 *
 * Only SIP calls can have a withheld number. A web-demo or widget call never had
 * one to withhold, so it keeps the plain dash.
 */

export interface CallerNumberSource {
  fromNumber?: string | null;
  customerPhone?: string | null;
  roomName?: string | null;
  twilioCallSid?: string | null;
}

/**
 * Did this call arrive over the phone? `twilioCallSid` is the reliable marker;
 * a SIP room name is the fallback for calls recorded before it was captured.
 */
export function isPhoneCall(call: CallerNumberSource): boolean {
  if (call.twilioCallSid) return true;
  return /^garage-/.test(call.roomName ?? '');
}

/**
 * A phone call that reached us with no usable caller ID. The room name is what
 * LiveKit built from the SIP From header, so an anonymous caller is named as
 * such right there — `garage-<id>_anonymous_<suffix>`.
 */
export function isWithheldNumber(call: CallerNumberSource, derivedNumber: string | null): boolean {
  if (derivedNumber) return false;
  if (!isPhoneCall(call)) return false;
  return /_anonymous(?:_|$)/i.test(call.roomName ?? '') || !call.fromNumber;
}

/**
 * What to show in a caller-number column: the number, "Number withheld", or a dash.
 *
 * `formatted` is the already-formatted number (a dash when there is none), so this
 * stays out of the business of formatting and each page keeps its own wording.
 */
export function callerNumberLabel(
  call: CallerNumberSource,
  derivedNumber: string | null,
  formatted: string,
  withheldLabel: string,
): string {
  return isWithheldNumber(call, derivedNumber) ? withheldLabel : formatted;
}
