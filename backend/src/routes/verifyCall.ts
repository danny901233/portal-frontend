import type { Request, Response } from 'express';
import { Router } from 'express';

/**
 * A number that forwards its calls, so a verification code read down the phone reaches a human.
 *
 * WhatsApp setup sends a one-time code by SMS or by voice call. Twilio's GB non-geographic
 * numbers are voice-only (`capabilities.sms` is false on +443330386043, the group WhatsApp number
 * bought for The Gearbox Centre's five branches on 2026-10-22), so Meta has to ring and read the
 * code aloud. With no voice_url set, that call rings out — and a ringing-out call is
 * indistinguishable from "Meta never called", which is the worst possible failure to debug while
 * someone sits in front of the setup screen waiting.
 *
 * Forwarding rather than recording and transcribing: a person on the line hears six spoken digits
 * correctly the first time, and this codebase's own notes are a catalogue of digits and letters
 * being misheard by STT.
 *
 * Temporary by nature. Once the number is registered on a WABA, nothing should be calling it, and
 * the forward can be removed by clearing voice_url.
 */

const router = Router();

/** Where to send the call. Set per environment rather than hard-coded to someone's mobile. */
export const FORWARD_TO_ENV = 'VERIFY_CALL_FORWARD_TO';

/** UK national or E.164, normalised to E.164. Anything else is not dialable. */
function toE164(raw: string): string | null {
  const trimmed = String(raw || '').replace(/[\s()-]/g, '');
  if (/^\+44\d{9,10}$/.test(trimmed)) return trimmed;
  if (/^0\d{9,10}$/.test(trimmed)) return `+44${trimmed.slice(1)}`;
  return null;
}

/**
 * The TwiML for an inbound call.
 *
 * `forwardTo` is validated before it goes anywhere near the document: TwiML is XML, so a stray
 * quote or angle bracket from a mistyped env var would produce malformed XML and Twilio would
 * fail the call with a 12100 instead of saying anything a caller could act on.
 */
export function forwardTwiml(forwardTo: string, calledNumber: string): string {
  const dest = toE164(forwardTo);
  const callerId = toE164(calledNumber);
  const head = '<?xml version="1.0" encoding="UTF-8"?>';
  if (!dest) {
    return `${head}<Response><Say voice="Polly.Amy">`
      + 'Call forwarding is not configured for this number. Please check the server settings.'
      + '</Say></Response>';
  }
  // 30s: Meta's robot starts reading almost immediately, and a long ring just delays the retry.
  const cid = callerId ? ` callerId="${callerId}"` : '';
  return `${head}<Response><Dial timeout="30"${cid}>${dest}</Dial></Response>`;
}

/**
 * POST/GET /webhooks/verify-call — Twilio's voice webhook for a number being verified.
 */
router.all('/verify-call', (req: Request, res: Response) => {
  const called = String((req.body && req.body.Called) || (req.query && req.query.Called) || '');
  const from = String((req.body && req.body.From) || (req.query && req.query.From) || '');
  const forwardTo = process.env[FORWARD_TO_ENV] || '';
  // Logged loudly: during a verification window this line is the only evidence the call arrived.
  console.log(`[VERIFY_CALL] inbound to ${called || '(unknown)'} from ${from || '(withheld)'} `
    + `— forwarding to ${toE164(forwardTo) || 'NOBODY (not configured)'}`);
  res.type('text/xml').send(forwardTwiml(forwardTo, called));
});

export default router;
