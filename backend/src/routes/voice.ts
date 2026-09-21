import type { Request, Response } from 'express';
import { Router } from 'express';
import { prisma } from '../db.js';
import { sendCallSummaryEmail, sendPaymentSetupReminderEmail } from '../utils/email.js';

const router = Router();

/**
 * Calls the screened human has actually accepted, keyed by the inbound call's SID.
 *
 * This exists because "did a person take the call?" cannot be read off DialCallStatus. When the
 * mobile is declined, the carrier diverts to voicemail, voicemail answers, and Twilio reports a
 * perfectly ordinary `completed` — so the caller ends up leaving a message instead of reaching
 * the agent, which is exactly what we are trying to avoid. A keypress is the only signal a
 * voicemail system cannot produce.
 *
 * In-memory is right here: the backend is a single pm2 fork, and an entry is only meaningful for
 * the few seconds between the whisper and the Dial ending.
 */
const screenAccepted = new Map<string, number>();
const ACCEPT_TTL_MS = 2 * 60 * 1000;

function markAccepted(callSid: string): void {
  const now = Date.now();
  for (const [sid, at] of screenAccepted) if (now - at > ACCEPT_TTL_MS) screenAccepted.delete(sid);
  screenAccepted.set(callSid, now);
}

function wasAccepted(callSid: string): boolean {
  const at = screenAccepted.get(callSid);
  if (at === undefined) return false;
  screenAccepted.delete(callSid);
  return Date.now() - at <= ACCEPT_TTL_MS;
}

function xmlEscape(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

router.post('/voice', async (req: Request, res: Response) => {
  const { garageId } = req.query;

  if (!garageId || typeof garageId !== 'string') {
    return res.status(400).send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Invalid request</Say></Response>');
  }

  // Fetch garage configuration to determine routing (agent type + which LK account)
  let agentType = 'assist';
  let agentScript: string | null = null;
  let screen = false;
  let screenSeconds = 15;
  let screenNumber: string | null = null;
  try {
    const agentConfig = await prisma.agentConfiguration.findUnique({
      where: { garageId },
      select: {
        agentType: true, agentScript: true,
        screenBeforeAgent: true, screenRingSeconds: true, screenNumber: true,
      },
    });

    if (!agentConfig) {
      return res
        .status(404)
        .send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Configuration not found for this garage.</Say><Hangup/></Response>');
    }

    // A garage that has been archived or had voice switched off must NOT have its calls
    // answered. Until now this route only checked that an AgentConfiguration existed, so
    // "deactivating" a garage in the portal stopped the billing while the agent kept picking up —
    // a former customer's callers handled indefinitely, for free.
    const garage = await prisma.garage.findUnique({
      where: { id: garageId },
      select: { name: true, archivedAt: true, hasVoiceAccess: true },
    });
    if (!garage || garage.archivedAt || garage.hasVoiceAccess === false) {
      console.warn(`[VOICE] Refusing call for ${garage?.name || garageId} — ` +
        `${!garage ? 'garage not found' : garage.archivedAt ? 'archived' : 'voice access disabled'}`);
      return res
        .type('text/xml')
        .send('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
    }

    if (agentConfig.agentType === 'automate') {
      agentType = 'automate';
    }
    agentScript = agentConfig.agentScript;
    screen = agentConfig.screenBeforeAgent === true;
    screenSeconds = agentConfig.screenRingSeconds ?? 15;
    screenNumber = agentConfig.screenNumber;
  } catch (error) {
    console.error('[VOICE] Error loading agent type for garage', garageId, error);
    return res
      .status(500)
      .send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Configuration error.</Say><Hangup/></Response>');
  }

  // Ring a human first. Only for lines whose published number IS the Twilio one — a normal
  // garage publishes its own number and forwards to us on no-answer, so the screening happens
  // on their phone system, not here. `action` is what makes this safe:
  // without it TwiML falls through to the next verb after a call that WAS answered and then
  // hung up, so the agent would ring the caller back after a real conversation had finished.
  if (screen && screenNumber) {
    const dialTarget = toDialable(screenNumber);
    if (dialTarget) {
      const timeout = Math.min(30, Math.max(5, screenSeconds));
      const base = process.env.PORTAL_BASE_URL || 'https://18.171.230.217';
      const action = `${base}/webhooks/voice/after-screen?garageId=${encodeURIComponent(garageId)}`;
      console.log(`[VOICE] Screening ${garageId}: ringing ${dialTarget} for ${timeout}s before the agent`);
      // callerId is the original caller so the answering phone shows who is actually ringing.
      // Twilio permits the inbound From to be re-presented when forwarding an inbound call.
      const callerId = typeof req.body?.From === 'string' ? req.body.From : '';
      // The whisper runs on the answering phone BEFORE the two are bridged, and asks for a
      // keypress. Voicemail can answer a call but it cannot press a key, so a declined call
      // that diverts to the answerphone never gets bridged and falls through to the agent.
      const whisper = `${base}/webhooks/voice/whisper?garageId=${encodeURIComponent(garageId)}`;
      res.type('text/xml');
      return res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="${timeout}" action="${action}" method="POST"${callerId ? ` callerId="${xmlEscape(callerId)}"` : ''}>
    <Number url="${xmlEscape(whisper)}" method="POST">${dialTarget}</Number>
  </Dial>
</Response>`);
    }
    console.warn(`[VOICE] Screening on for ${garageId} but screenNumber ${screenNumber} is not dialable — going straight to the agent`);
  }

  const twiml = await buildAgentDialTwiml(garageId, agentScript);
  if (!twiml) {
    return res
      .status(500)
      .send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Call routing is not configured.</Say><Hangup/></Response>');
  }
  res.type('text/xml');
  res.send(twiml);
});

/**
 * Runs on the answering phone, after it picks up but before the caller is bridged to it.
 *
 * Says who is calling and waits for a key. Pressing 1 connects; anything else, or silence,
 * ends this leg and the caller goes to the agent.
 */
router.post('/voice/whisper', async (req: Request, res: Response) => {
  const garageId = String(req.query.garageId || '');
  // The inbound call's SID — the same value the after-screen action will see as CallSid, which
  // is what lets the two halves agree on which call was accepted.
  const parent = String(req.body?.ParentCallSid || req.body?.CallSid || '');
  const base = process.env.PORTAL_BASE_URL || 'https://18.171.230.217';
  const action = `${base}/webhooks/voice/whisper-accept` +
    `?garageId=${encodeURIComponent(garageId)}&parent=${encodeURIComponent(parent)}`;

  const cfg = await prisma.agentConfiguration.findUnique({
    where: { garageId },
    select: { screenAnnouncement: true, branchName: true },
  });
  const line = (cfg?.screenAnnouncement || '').trim() || `New enquiry for ${cfg?.branchName || 'you'}`;

  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" timeout="6" action="${xmlEscape(action)}" method="POST">
    <Say voice="Polly.Amy">${xmlEscape(line)}. Press one to take it, or two to send it to the assistant.</Say>
  </Gather>
  <Hangup/>
</Response>`);
});

/**
 * The keypress. 1 connects the two legs; anything else drops this one so the agent gets the call.
 */
router.post('/voice/whisper-accept', async (req: Request, res: Response) => {
  const parent = String(req.query.parent || req.body?.ParentCallSid || '');
  const digits = String(req.body?.Digits || '');

  if (digits === '1' && parent) {
    markAccepted(parent);
    console.log(`[VOICE] Screened call ${parent} accepted by keypress — connecting`);
    // Empty response: the whisper document ends here and Twilio bridges the two legs.
    return res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  }

  const why = digits === '2' ? 'declined with 2' : digits ? `pressed ${digits}` : 'no keypress';
  console.log(`[VOICE] Screened call ${parent} not accepted (${why}) — passing to the agent`);
  res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
});

/**
 * Where a screened call lands once the human's phone has stopped ringing.
 *
 * DialCallStatus is 'completed' when they picked up — the conversation has already happened, so
 * the call ends here. Anything else (no-answer, busy, failed, canceled) means nobody took it and
 * the agent gets it, exactly as if screening had been off.
 */
router.post('/voice/after-screen', async (req: Request, res: Response) => {
  const { garageId } = req.query;
  const status = String(req.body?.DialCallStatus || '');
  if (!garageId || typeof garageId !== 'string') {
    return res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
  }

  // Deliberately NOT driven by DialCallStatus. A declined mobile diverts to its voicemail,
  // voicemail answers, and Twilio reports 'completed' — indistinguishable from a real
  // conversation. The keypress recorded by the whisper is the only trustworthy signal that a
  // person took the call, so that is what decides it.
  const callSid = String(req.body?.CallSid || '');
  if (callSid && wasAccepted(callSid)) {
    console.log(`[VOICE] Screened call for ${garageId} was taken by a person (status=${status}) — done`);
    return res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
  }

  // Re-check access here too: a call can sit ringing for half a minute, and this is a second
  // public entry point into the same routing.
  const garage = await prisma.garage.findUnique({
    where: { id: garageId },
    select: { name: true, archivedAt: true, hasVoiceAccess: true },
  });
  if (!garage || garage.archivedAt || garage.hasVoiceAccess === false) {
    return res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
  }

  const cfg = await prisma.agentConfiguration.findUnique({
    where: { garageId },
    select: { agentScript: true },
  });
  const twiml = await buildAgentDialTwiml(garageId, cfg?.agentScript ?? null);
  if (!twiml) {
    return res
      .status(500)
      .send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Call routing is not configured.</Say><Hangup/></Response>');
  }
  console.log(`[VOICE] Screened call for ${garageId} not taken (status=${status || 'none'}) — passing to the agent`);
  res.type('text/xml');
  res.send(twiml);
});

/** Normalise a stored number to something Twilio will dial: UK leading 0 -> +44. */
function toDialable(raw: string): string | null {
  const t = raw.replace(/[^\d+]/g, '');
  if (/^\+\d{10,15}$/.test(t)) return t;
  if (/^0\d{9,10}$/.test(t)) return '+44' + t.slice(1);
  if (/^44\d{9,10}$/.test(t)) return '+' + t;
  return null;
}

/**
 * Build the TwiML that hands the call to the agent's LiveKit SIP address.
 *
 * Lifted out of the /voice handler so the screening fall-through (/voice/after-screen) reaches
 * exactly the same routing rather than a second copy that could drift. Nothing about which
 * account a garage lands on is derived from the request — it is all re-read from the database
 * by garageId, because /voice is a public webhook and a SIP target passed through a query
 * string would be an open relay.
 */
async function buildAgentDialTwiml(garageId: string, agentScript: string | null): Promise<string | null> {
  // Route to LK Account 2 for garages assigned to the RMB Assist agent
  // (deployed on receptionmate-9dznd24r). All other agentScripts continue to
  // dial Account 1's hardcoded SIP host. Falls back to Account 1 if the
  // Account 2 env var is not set — fail-safe so production stays unchanged.
  // Test routing for the optimised-tyresoft agent on receptionmate-2-kiutenc8
  // (sandbox project). Only RM Branch should use 'tyresoft-agent-test' as
  // agentScript; production Elite stays on 'tyresoft-agent' → Account 1.
  const isTyresoftTest = agentScript === 'tyresoft-agent-test';
  // The unified (one agent, many diaries) prototype lives in its own LiveKit project,
  // receptionmate-automotive-h83idqna, precisely so it shares nothing with a live slot.
  // Same arrangement as tyresoft-agent-test above: only ReceptionMate Branch should ever
  // carry this agentScript. If the env var is unset this falls through to Account 1, so a
  // missing variable degrades to today's behaviour rather than dropping calls.
  const isUnified = agentScript === 'unified-agent';
  const isAccount2 = agentScript === 'Assist-agent' || agentScript === 'GarageHive-agent';
  const isMMH = agentScript === 'MMH-agent';
  const isBookar = agentScript === 'bookar-agent';
  const isPoole = agentScript === 'poole-agent';
  const livekitSipDomain =
    isUnified && process.env.LIVEKIT_SIP_DOMAIN_UNIFIED
      ? process.env.LIVEKIT_SIP_DOMAIN_UNIFIED
      : isTyresoftTest && process.env.LIVEKIT_SIP_DOMAIN_TYRESOFT_TEST
      ? process.env.LIVEKIT_SIP_DOMAIN_TYRESOFT_TEST
      : isAccount2 && process.env.LIVEKIT_SIP_DOMAIN_ACCOUNT2
        ? process.env.LIVEKIT_SIP_DOMAIN_ACCOUNT2
        : isMMH && process.env.LIVEKIT_SIP_DOMAIN_MMH
          ? process.env.LIVEKIT_SIP_DOMAIN_MMH
          : isBookar && process.env.LIVEKIT_SIP_DOMAIN_BOOKAR
            ? process.env.LIVEKIT_SIP_DOMAIN_BOOKAR
            : isPoole && process.env.LIVEKIT_SIP_DOMAIN_POOLE
              ? process.env.LIVEKIT_SIP_DOMAIN_POOLE
              : (
                process.env.LIVEKIT_SIP_DOMAIN ||
                process.env.LIVEKIT_SIP_DOMAIN_AUTOMATE ||
                process.env.LIVEKIT_SIP_DOMAIN_ASSIST
              );

  if (!livekitSipDomain) {
    console.error(`[VOICE] No SIP domain resolved for garage ${garageId} (agentScript=${agentScript})`);
    return null;
  }

  const account = isTyresoftTest ? 'tyresoft-test' : isAccount2 ? 'account2' : isMMH ? 'mmh' : isBookar ? 'bookar' : isPoole ? 'poole' : 'account1';
  console.log(`[VOICE] Routing garage ${garageId} (agentScript=${agentScript}, account=${account}) via ${livekitSipDomain}`);

  // Build recording status callback URL
  const portalBaseUrl = process.env.PORTAL_BASE_URL || 'https://18.171.230.217';
  const recordingCallbackUrl = `${portalBaseUrl}/webhooks/recording-status`;

  // Twilio outbound-SIP edge. Default is the US Virginia (Ashburn) edge, which adds a
  // transatlantic hop for UK callers -> EU LiveKit. Pin ALL garages to the Frankfurt edge —
  // every LiveKit project/agent is in eu-central (Germany). Twilio strips ;edge= before it
  // forwards the INVITE to LiveKit. Verified on MMH: SIP edge Frankfurt (de1), Twilio RTP
  // latency <10ms (was 36ms via the US Ashburn edge).
  const sipEdge = ';edge=frankfurt';

  // Return TwiML that dials the LiveKit SIP address with recording enabled
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial record="record-from-answer" recordingStatusCallback="${recordingCallbackUrl}" recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="completed">
    <Sip>sip:${garageId}@${livekitSipDomain}${sipEdge}</Sip>
  </Dial>
</Response>`;

  return twiml;
}

// Twilio recording status callback
router.post('/recording-status', async (req: Request, res: Response) => {
  try {
    console.log('[RECORDING] Twilio recording status callback:', req.body);
    
    const { 
      RecordingSid, 
      RecordingUrl, 
      RecordingStatus,
      CallSid,
      RecordingDuration 
    } = req.body;
    
    if (RecordingStatus === 'completed' && RecordingUrl && CallSid) {
      console.log(`[RECORDING] ✅ Recording completed:`);
      console.log(`[RECORDING]    CallSid: ${CallSid}`);
      console.log(`[RECORDING]    RecordingSid: ${RecordingSid}`);
      console.log(`[RECORDING]    RecordingUrl: ${RecordingUrl}`);
      console.log(`[RECORDING]    Duration: ${RecordingDuration}s`);

      const durationSeconds = RecordingDuration ? Number.parseInt(RecordingDuration, 10) : null;
      const completedAt = new Date();

      await prisma.twilioRecording.upsert({
        where: { callSid: CallSid },
        update: {
          recordingSid: RecordingSid,
          recordingUrl: RecordingUrl,
          recordingDurationSeconds: Number.isNaN(durationSeconds ?? NaN) ? null : durationSeconds,
          completedAt,
        },
        create: {
          callSid: CallSid,
          recordingSid: RecordingSid,
          recordingUrl: RecordingUrl,
          recordingDurationSeconds: Number.isNaN(durationSeconds ?? NaN) ? null : durationSeconds,
          completedAt,
        },
      });

      console.log(`[RECORDING] Stored recording for CallSid ${CallSid}`);

      // Update call duration with recording duration (actual call time)
      // OR delete the call if it's under the minimum billable/logged length.
      // 45s is the business rule: calls shorter than this never surface in the portal.
      if (durationSeconds !== null && !Number.isNaN(durationSeconds)) {
        // If recording duration is under 45 seconds, delete the call from portal
        if (durationSeconds < 45) {
          const deletedCalls = await prisma.call.deleteMany({
            where: {
              twilioCallSid: CallSid,
            },
          });

          if (deletedCalls.count > 0) {
            console.log(`[RECORDING] 🗑️  Deleted ${deletedCalls.count} call(s) - recording duration ${durationSeconds}s is under 45s threshold`);
          }
        } else {
          // Duration is >= 45 seconds, update the call with correct duration
          const updatedCalls = await prisma.call.updateMany({
            where: {
              twilioCallSid: CallSid,
              recordingDurationSeconds: null, // Only update calls that don't have recording duration yet
            },
            data: {
              durationSeconds,
              recordingDurationSeconds: durationSeconds,
              recordingUrl: RecordingSid,
              recordingCompletedAt: completedAt,
            },
          });

          if (updatedCalls.count > 0) {
            console.log(`[RECORDING] ✅ Updated ${updatedCalls.count} call(s) with recording duration: ${durationSeconds}s`);

            // Send notification email now that we've confirmed duration >= 45s
            const call = await prisma.call.findFirst({
              where: { twilioCallSid: CallSid },
              include: {
                garage: {
                  include: {
                    agentConfiguration: {
                      select: {
                        branchName: true,
                        notificationEmails: true,
                      },
                    },
                  },
                },
              },
            });

            if (call?.garage?.agentConfiguration?.notificationEmails &&
                call.garage.agentConfiguration.notificationEmails.length > 0) {
              console.log(`[RECORDING] 📧 Checking payment status for notification email (call ${durationSeconds}s duration)`);

              // Check if any users with access to this garage need to set up payment
              const usersWithAccess = await prisma.user.findMany({
                where: {
                  garageAccessIds: {
                    has: call.garageId
                  }
                },
                select: {
                  email: true,
                  mustSetupPayment: true
                }
              });

              const userNeedsPaymentSetup = usersWithAccess.some(u => u.mustSetupPayment);
              const portalUrl = process.env.PORTAL_URL || 'https://portal.receptionmate.co.uk';

              if (userNeedsPaymentSetup) {
                console.log(`[RECORDING] 💳 User(s) need payment setup - sending payment reminder email instead`);
                
                void sendPaymentSetupReminderEmail(call.garage.agentConfiguration.notificationEmails, {
                  branchName: call.garage.agentConfiguration.branchName,
                  summary: call.summary,
                  customerPhone: call.customerPhone,
                  createdAt: call.createdAt.toISOString(),
                  portalUrl,
                }).catch((error) => {
                  console.error('[RECORDING] Failed to send payment reminder email:', error);
                });
              } else {
                console.log(`[RECORDING] ✅ Sending standard call summary email`);
                
                void sendCallSummaryEmail(call.garage.agentConfiguration.notificationEmails, {
                  branchName: call.garage.agentConfiguration.branchName,
                  summary: call.summary,
                  transcript: call.transcript as any,
                  durationSeconds: durationSeconds,
                  callType: call.callType,
                  customerName: call.customerName,
                  customerPhone: call.customerPhone,
                  registrationNumber: call.registrationNumber,
                  confirmedBooking: call.confirmedBooking,
                  capturedRevenue: call.capturedRevenue,
                  createdAt: call.createdAt.toISOString(),
                  bookingDate: null,
                  priceQuoted: call.capturedRevenue,
                }).catch((error) => {
                  console.error('[RECORDING] Failed to send notification email:', error);
                });
              }
            }
          } else {
            console.log(`[RECORDING] No calls updated for CallSid ${CallSid} (may already have recording duration)`);
          }
        }
      }
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('[RECORDING] Error processing recording callback:', error);
    res.status(500).send('Error');
  }
});

export default router;
