// Outbound click-to-call using the garage's OWN existing number as the caller ID.
//
// Two parts:
//  1. Caller-ID verification — Twilio's Verified Caller ID flow. The garage's
//     existing number is verified (Twilio calls it, they key in a code) so it
//     can be presented as the `From` on outbound calls without CLI spoofing.
//     The garage keeps their number where it is — nothing is ported.
//  2. Click-to-call bridge — the staff member's phone rings; when they answer,
//     Twilio dials the destination presenting the garage's verified number. A
//     human has the conversation ("not the voice agent").
//
// Single Twilio account for now (matches current provisioning). At scale each
// garage would get its own subaccount so verified-caller-ID limits never bite.

import type { Request, Response } from 'express';
import { Router } from 'express';
import twilio from 'twilio';
import { prisma } from '../db.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

function getTwilioClient() {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    throw new Error('Twilio credentials not configured');
  }
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

/** Normalise a UK/E.164 phone number for Twilio. */
function normalisePhone(raw: string): string {
  let n = (raw || '').replace(/^whatsapp:/i, '').replace(/[\s\-().]/g, '');
  if (/^07\d{9}$/.test(n)) n = `+44${n.slice(1)}`;
  else if (/^44\d{10}$/.test(n)) n = `+${n}`;
  else if (/^0\d{9,10}$/.test(n)) n = `+44${n.slice(1)}`;
  return n;
}

/** Confirm the signed-in user may act on this garage. */
async function userCanAccessGarage(req: Request, garageId: string): Promise<boolean> {
  const u = req.user;
  if (!u) return false;
  if (u.role === 'RECEPTIONMATE_STAFF') return true;
  const ids: string[] = u.garageIds || [];
  return ids.includes(garageId);
}

// ---------------------------------------------------------------------------
// GET /api/outbound-calls/caller-id?garageId=... — current caller-ID state
// ---------------------------------------------------------------------------
router.get('/outbound-calls/caller-id', authenticate, async (req: Request, res: Response) => {
  const garageId = String(req.query.garageId || '');
  if (!garageId) return res.status(400).json({ error: 'garageId required' });
  if (!(await userCanAccessGarage(req, garageId))) return res.status(403).json({ error: 'Forbidden' });

  const garage = await prisma.garage.findUnique({
    where: { id: garageId },
    select: { outboundCallerId: true, outboundCallerIdVerified: true },
  });
  if (!garage) return res.status(404).json({ error: 'Garage not found' });
  return res.json({
    number: garage.outboundCallerId,
    verified: garage.outboundCallerIdVerified,
  });
});

// ---------------------------------------------------------------------------
// POST /api/outbound-calls/caller-id/start — begin verifying the garage's number
// Body: { garageId, number }
// Returns: { validationCode } — show this to the user; Twilio calls the number
// and asks them to key it in. Poll /caller-id/status to confirm.
// ---------------------------------------------------------------------------
router.post('/outbound-calls/caller-id/start', authenticate, async (req: Request, res: Response) => {
  try {
    const { garageId, number } = req.body as { garageId?: string; number?: string };
    if (!garageId || !number) return res.status(400).json({ error: 'garageId and number required' });
    if (!(await userCanAccessGarage(req, garageId))) return res.status(403).json({ error: 'Forbidden' });

    const e164 = normalisePhone(number);
    if (!/^\+\d{10,15}$/.test(e164)) return res.status(400).json({ error: 'Enter a valid phone number' });

    const garage = await prisma.garage.findUnique({ where: { id: garageId }, select: { name: true } });
    if (!garage) return res.status(404).json({ error: 'Garage not found' });

    const client = getTwilioClient();

    // If it's already a verified caller ID on the account, just record it.
    const existing = await client.outgoingCallerIds.list({ phoneNumber: e164, limit: 1 });
    if (existing.length) {
      await prisma.garage.update({
        where: { id: garageId },
        data: { outboundCallerId: e164, outboundCallerIdVerified: true, outboundCallerIdSid: existing[0].sid },
      });
      return res.json({ alreadyVerified: true, number: e164 });
    }

    const validation = await client.validationRequests.create({
      friendlyName: `${garage.name} (outbound caller ID)`,
      phoneNumber: e164,
    });

    // Store as pending (not verified until they enter the code).
    await prisma.garage.update({
      where: { id: garageId },
      data: { outboundCallerId: e164, outboundCallerIdVerified: false, outboundCallerIdSid: null },
    });

    return res.json({ validationCode: validation.validationCode, number: e164 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to start verification';
    console.error('[outbound-calls] caller-id/start error:', msg);
    return res.status(500).json({ error: msg });
  }
});

// ---------------------------------------------------------------------------
// GET /api/outbound-calls/caller-id/status?garageId=... — poll verification
// Marks verified once the number appears in the account's Outgoing Caller IDs.
// ---------------------------------------------------------------------------
router.get('/outbound-calls/caller-id/status', authenticate, async (req: Request, res: Response) => {
  try {
    const garageId = String(req.query.garageId || '');
    if (!garageId) return res.status(400).json({ error: 'garageId required' });
    if (!(await userCanAccessGarage(req, garageId))) return res.status(403).json({ error: 'Forbidden' });

    const garage = await prisma.garage.findUnique({
      where: { id: garageId },
      select: { outboundCallerId: true, outboundCallerIdVerified: true },
    });
    if (!garage?.outboundCallerId) return res.json({ verified: false, number: null });
    if (garage.outboundCallerIdVerified) return res.json({ verified: true, number: garage.outboundCallerId });

    const client = getTwilioClient();
    const found = await client.outgoingCallerIds.list({ phoneNumber: garage.outboundCallerId, limit: 1 });
    if (found.length) {
      await prisma.garage.update({
        where: { id: garageId },
        data: { outboundCallerIdVerified: true, outboundCallerIdSid: found[0].sid },
      });
      return res.json({ verified: true, number: garage.outboundCallerId });
    }
    return res.json({ verified: false, number: garage.outboundCallerId });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to check status';
    console.error('[outbound-calls] caller-id/status error:', msg);
    return res.status(500).json({ error: msg });
  }
});

// ---------------------------------------------------------------------------
// POST /api/outbound-calls/dial — click-to-call bridge
// Body: { garageId, to, agentPhone }
//   - rings `agentPhone` (the staff member's phone)
//   - on answer, dials `to`, presenting the garage's verified number
// ---------------------------------------------------------------------------
router.post('/outbound-calls/dial', authenticate, async (req: Request, res: Response) => {
  try {
    const { garageId, to, agentPhone } = req.body as { garageId?: string; to?: string; agentPhone?: string };
    if (!garageId || !to || !agentPhone) {
      return res.status(400).json({ error: 'garageId, to and agentPhone required' });
    }
    if (!(await userCanAccessGarage(req, garageId))) return res.status(403).json({ error: 'Forbidden' });

    const garage = await prisma.garage.findUnique({
      where: { id: garageId },
      select: { outboundCallerId: true, outboundCallerIdVerified: true, twilioNumber: true },
    });
    if (!garage?.outboundCallerId || !garage.outboundCallerIdVerified) {
      return res.status(400).json({ error: 'Verify the garage caller ID before making calls.' });
    }

    const toE164 = normalisePhone(to);
    const agentE164 = normalisePhone(agentPhone);
    if (!/^\+\d{10,15}$/.test(toE164) || !/^\+\d{10,15}$/.test(agentE164)) {
      return res.status(400).json({ error: 'Enter valid phone numbers' });
    }

    const callerId = garage.outboundCallerId;
    // Ring the staff FROM a Twilio number we own (not the caller ID) — avoids a
    // "To and From cannot be the same" error when the staff phone == caller ID,
    // and works even before any number is ported. Leg 2 presents the caller ID.
    const legFrom = normalisePhone(garage.twilioNumber || callerId);
    if (legFrom === agentE164) {
      return res.status(400).json({ error: 'Your phone must be different from the garage number.' });
    }
    const client = getTwilioClient();
    const publicBase = (process.env.PUBLIC_BASE_URL || 'https://portal.receptionmate.co.uk').replace(/\/$/, '');

    // Leg 1: ring the staff member. On answer, Leg 2 dials the destination
    // presenting the garage's verified number.
    const twiml =
      `<Response><Say voice="Polly.Amy">Connecting your call.</Say>` +
      `<Dial callerId="${callerId}" timeout="30">${toE164}</Dial></Response>`;

    const call = await client.calls.create({
      to: agentE164,
      from: legFrom,
      twiml,
      statusCallback: `${publicBase}/api/outbound-calls/status-callback`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST',
    });

    await prisma.outboundCall.create({
      data: {
        garageId,
        toNumber: toE164,
        callerId,
        agentPhone: agentE164,
        twilioCallSid: call.sid,
        status: call.status || 'initiated',
      },
    });

    return res.json({ success: true, callSid: call.sid });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to place call';
    console.error('[outbound-calls] dial error:', msg);
    return res.status(500).json({ error: msg });
  }
});

// ---------------------------------------------------------------------------
// Browser calling (Twilio Voice SDK)
// GET /api/outbound-calls/token?garageId=... — AccessToken for the softphone
// ---------------------------------------------------------------------------
router.get('/outbound-calls/token', authenticate, async (req: Request, res: Response) => {
  const garageId = String(req.query.garageId || '');
  if (!garageId) return res.status(400).json({ error: 'garageId required' });
  if (!(await userCanAccessGarage(req, garageId))) return res.status(403).json({ error: 'Forbidden' });

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const apiKeySid = process.env.TWILIO_API_KEY_SID;
  const apiKeySecret = process.env.TWILIO_API_KEY_SECRET;
  const appSid = process.env.TWILIO_TWIML_APP_SID;
  if (!accountSid || !apiKeySid || !apiKeySecret || !appSid) {
    return res.status(500).json({ error: 'Browser calling is not configured' });
  }

  const AccessToken = twilio.jwt.AccessToken;
  const VoiceGrant = AccessToken.VoiceGrant;
  const identity = `garage_${garageId}`;
  const token = new AccessToken(accountSid, apiKeySid, apiKeySecret, { identity, ttl: 3600 });
  token.addGrant(new VoiceGrant({ outgoingApplicationSid: appSid, incomingAllow: false }));
  return res.json({ token: token.toJwt(), identity });
});

// ---------------------------------------------------------------------------
// POST /api/outbound-calls/voice — TwiML App voice URL (public; Twilio calls it
// when the browser Device connects). Dials the destination with the garage's
// caller ID and logs the call.
// ---------------------------------------------------------------------------
router.post('/outbound-calls/voice', async (req: Request, res: Response) => {
  const body = req.body as { To?: string; callerId?: string; garageId?: string; CallSid?: string };
  const to = normalisePhone(String(body.To || ''));
  const callerId = String(body.callerId || '');
  const garageId = String(body.garageId || '');
  const vr = new twilio.twiml.VoiceResponse();

  if (!to || !/^\+\d{10,15}$/.test(to) || !callerId) {
    vr.say('Sorry, the call could not be connected.');
  } else {
    const dial = vr.dial({ callerId });
    dial.number(to);
    if (garageId) {
      prisma.outboundCall
        .create({ data: { garageId, toNumber: to, callerId, agentPhone: 'browser', twilioCallSid: body.CallSid || undefined, status: 'in-progress' } })
        .catch((e) => console.error('[outbound-calls] voice log error:', e?.message));
    }
  }
  res.type('text/xml').send(vr.toString());
});

// ---------------------------------------------------------------------------
// GET /api/outbound-calls/logs?garageId=... — outbound call log
// ---------------------------------------------------------------------------
router.get('/outbound-calls/logs', authenticate, async (req: Request, res: Response) => {
  const garageId = String(req.query.garageId || '');
  if (!garageId) return res.status(400).json({ error: 'garageId required' });
  if (!(await userCanAccessGarage(req, garageId))) return res.status(403).json({ error: 'Forbidden' });
  const logs = await prisma.outboundCall.findMany({
    where: { garageId },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: { id: true, toNumber: true, callerId: true, agentPhone: true, status: true, durationSeconds: true, createdAt: true },
  });
  return res.json({ logs });
});

// ---------------------------------------------------------------------------
// POST /api/outbound-calls/status-callback — Twilio call status webhook (public)
// ---------------------------------------------------------------------------
router.post('/outbound-calls/status-callback', async (req: Request, res: Response) => {
  try {
    const body = req.body as { CallSid?: string; CallStatus?: string; CallDuration?: string };
    if (body.CallSid) {
      await prisma.outboundCall.updateMany({
        where: { twilioCallSid: body.CallSid },
        data: {
          status: body.CallStatus || undefined,
          durationSeconds: body.CallDuration ? parseInt(body.CallDuration, 10) : undefined,
        },
      });
    }
  } catch (err) {
    console.error('[outbound-calls] status-callback error:', err);
  }
  res.type('text/xml').send('<Response/>');
});

export default router;
