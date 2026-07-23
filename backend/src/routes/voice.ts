import type { Request, Response } from 'express';
import { Router } from 'express';
import { prisma } from '../db.js';
import { sendCallSummaryEmail, sendPaymentSetupReminderEmail } from '../utils/email.js';

const router = Router();

router.post('/voice', async (req: Request, res: Response) => {
  const { garageId } = req.query;

  if (!garageId || typeof garageId !== 'string') {
    return res.status(400).send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Invalid request</Say></Response>');
  }

  // Fetch garage configuration to determine routing (agent type + which LK account)
  let agentType = 'assist';
  let agentScript: string | null = null;
  try {
    const agentConfig = await prisma.agentConfiguration.findUnique({
      where: { garageId },
      select: { agentType: true, agentScript: true },
    });

    if (!agentConfig) {
      return res
        .status(404)
        .send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Configuration not found for this garage.</Say><Hangup/></Response>');
    }

    if (agentConfig.agentType === 'automate') {
      agentType = 'automate';
    }
    agentScript = agentConfig.agentScript;
  } catch (error) {
    console.error('[VOICE] Error loading agent type for garage', garageId, error);
    return res
      .status(500)
      .send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Configuration error.</Say><Hangup/></Response>');
  }

  // Route to LK Account 2 for garages assigned to the RMB Assist agent
  // (deployed on receptionmate-9dznd24r). All other agentScripts continue to
  // dial Account 1's hardcoded SIP host. Falls back to Account 1 if the
  // Account 2 env var is not set — fail-safe so production stays unchanged.
  // Test routing for the optimised-tyresoft agent on receptionmate-2-kiutenc8
  // (sandbox project). Only RM Branch should use 'tyresoft-agent-test' as
  // agentScript; production Elite stays on 'tyresoft-agent' → Account 1.
  const isTyresoftTest = agentScript === 'tyresoft-agent-test';
  const isAccount2 = agentScript === 'Assist-agent' || agentScript === 'GarageHive-agent';
  const isMMH = agentScript === 'MMH-agent';
  const isBookar = agentScript === 'bookar-agent';
  const livekitSipDomain =
    isTyresoftTest && process.env.LIVEKIT_SIP_DOMAIN_TYRESOFT_TEST
      ? process.env.LIVEKIT_SIP_DOMAIN_TYRESOFT_TEST
      : isAccount2 && process.env.LIVEKIT_SIP_DOMAIN_ACCOUNT2
        ? process.env.LIVEKIT_SIP_DOMAIN_ACCOUNT2
        : isMMH && process.env.LIVEKIT_SIP_DOMAIN_MMH
          ? process.env.LIVEKIT_SIP_DOMAIN_MMH
          : isBookar && process.env.LIVEKIT_SIP_DOMAIN_BOOKAR
            ? process.env.LIVEKIT_SIP_DOMAIN_BOOKAR
            : (
                process.env.LIVEKIT_SIP_DOMAIN ||
                process.env.LIVEKIT_SIP_DOMAIN_AUTOMATE ||
                process.env.LIVEKIT_SIP_DOMAIN_ASSIST
              );

  if (!livekitSipDomain) {
    return res
      .status(500)
      .send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Call routing is not configured.</Say><Hangup/></Response>');
  }

  const account = isTyresoftTest ? 'tyresoft-test' : isAccount2 ? 'account2' : isMMH ? 'mmh' : isBookar ? 'bookar' : 'account1';
  console.log(`[VOICE] Routing garage ${garageId} (agentType=${agentType}, agentScript=${agentScript}, account=${account}) via ${livekitSipDomain}`);

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

  res.type('text/xml');
  res.send(twiml);
});

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
