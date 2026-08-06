import { Router } from 'express';
import type { Request, Response } from 'express';

const router = Router();

/**
 * POST /api/webhooks/sip-dial
 *
 * Called by Twilio when LiveKit makes an outbound SIP call via the
 * Programmable SIP Domain for warm transfers.
 *
 * LiveKit sends the call to: +447XXXXXXXXX@receptionmate-outbound.sip.twilio.com
 * Twilio extracts the destination number and POSTs it here as `To`.
 *
 * We respond with TwiML that dials the destination number.
 */
router.post('/sip-dial', (req: Request, res: Response) => {
  const rawTo: string = req.body?.To ?? '';

  // `To` from Twilio SIP domain webhook can arrive in several forms:
  // "sip:+447700900123@receptionmate-outbound.sip.twilio.com"
  // "sip:tel:+447700900123@receptionmate-outbound.sip.twilio.com" ← LiveKit wraps
  //   the tel: URI as the SIP user part; sipMatch fires but captures "tel:+44..."
  // "tel:+447700900123"
  // "+447700900123"
  // IMPORTANT: never pass "tel:" into <Number> — Twilio maps letters via phone
  // keypad (T=8, E=3, L=5) so "+tel:+44..." becomes "+835+44...", corrupting it.
  let destination = rawTo;
  const sipMatch = rawTo.match(/^sip:([^@]+)@/);
  if (sipMatch) {
    destination = sipMatch[1];
  }
  // Strip tel: prefix whether it was the full rawTo or a nested SIP user part
  const telMatch = destination.match(/^tel:(.+)$/);
  if (telMatch) {
    destination = telMatch[1];
  }

  // URL form-encoded `+` arrives as a space — restore E.164 format
  destination = destination.trim().replace(/^\s+/, '');
  if (destination && !destination.startsWith('+')) {
    destination = '+' + destination;
  }

  if (!destination || destination === '+') {
    res.status(400).send('<Response><Reject/></Response>');
    return;
  }

  // Caller ID: use the configured outbound number, or fall back to the From header
  const callerId = process.env.SIP_DIAL_CALLER_ID || req.body?.From || '+441234000000';

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial callerId="${callerId}" timeout="30">
    <Number>${destination}</Number>
  </Dial>
</Response>`;

  res.set('Content-Type', 'text/xml');
  res.send(twiml);
});

export default router;
