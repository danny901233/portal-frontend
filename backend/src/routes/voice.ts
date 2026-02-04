import type { Request, Response } from 'express';
import { Router } from 'express';
import { prisma } from '../db.js';
import { sendCallSummaryEmail } from '../utils/email.js';

const router = Router();

router.post('/voice', async (req: Request, res: Response) => {
  const { garageId } = req.query;

  if (!garageId || typeof garageId !== 'string') {
    return res.status(400).send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Invalid request</Say></Response>');
  }

  // Fetch garage configuration to log the current agent type (assist vs automate)
  let agentType = 'assist';
  try {
    const agentConfig = await prisma.agentConfiguration.findUnique({
      where: { garageId },
      select: { agentType: true },
    });

    if (!agentConfig) {
      return res
        .status(404)
        .send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Configuration not found for this garage.</Say><Hangup/></Response>');
    }

    if (agentConfig.agentType === 'automate') {
      agentType = 'automate';
    }
  } catch (error) {
    console.error('[VOICE] Error loading agent type for garage', garageId, error);
    return res
      .status(500)
      .send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Configuration error.</Say><Hangup/></Response>');
  }

  // Always dial the unified LiveKit SIP domain; behaviour differences happen inside the agent codepath
  const livekitSipDomain =
    process.env.LIVEKIT_SIP_DOMAIN ||
    process.env.LIVEKIT_SIP_DOMAIN_AUTOMATE ||
    process.env.LIVEKIT_SIP_DOMAIN_ASSIST;

  if (!livekitSipDomain) {
    return res
      .status(500)
      .send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Call routing is not configured.</Say><Hangup/></Response>');
  }

  console.log(`[VOICE] Routing garage ${garageId} (agentType=${agentType}) via ${livekitSipDomain}`);

  // Build recording status callback URL
  const portalBaseUrl = process.env.PORTAL_BASE_URL || 'https://18.171.230.217';
  const recordingCallbackUrl = `${portalBaseUrl}/webhooks/recording-status`;

  // Return TwiML that dials the LiveKit SIP address with recording enabled
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial record="record-from-answer" recordingStatusCallback="${recordingCallbackUrl}" recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="completed">
    <Sip>sip:${garageId}@${livekitSipDomain}</Sip>
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
      // OR delete the call if duration is under 55 seconds
      if (durationSeconds !== null && !Number.isNaN(durationSeconds)) {
        // If recording duration is under 55 seconds, delete the call from portal
        if (durationSeconds < 55) {
          const deletedCalls = await prisma.call.deleteMany({
            where: {
              twilioCallSid: CallSid,
            },
          });

          if (deletedCalls.count > 0) {
            console.log(`[RECORDING] 🗑️  Deleted ${deletedCalls.count} call(s) - recording duration ${durationSeconds}s is under 55s threshold`);
          } else {
            // Fallback: No calls found by twilioCallSid, try timestamp matching for deletion
            console.log(`[RECORDING] No calls deleted by CallSid - trying fallback deletion by timestamp`);

            const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
            const recentCalls = await prisma.call.findMany({
              where: {
                createdAt: { gte: fiveMinutesAgo },
                recordingDurationSeconds: null,
              },
              orderBy: { createdAt: 'desc' },
              take: 1,
            });

            if (recentCalls.length > 0) {
              await prisma.call.delete({
                where: { id: recentCalls[0].id },
              });
              console.log(`[RECORDING] 🗑️  Deleted call ${recentCalls[0].id} via fallback - duration ${durationSeconds}s under 55s threshold`);
            }
          }
        } else {
          // Duration is >= 55 seconds, update the call with correct duration
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

            // Send notification email now that we've confirmed duration >= 55s
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
              console.log(`[RECORDING] 📧 Sending notification email for call with ${durationSeconds}s duration`);

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
          } else {
            console.log(`[RECORDING] No calls updated for CallSid ${CallSid} - trying fallback match by timestamp`);

            // Fallback: Find call by matching recent calls with similar timestamp
            // Recording callback usually arrives within 5-10 seconds of call end
            const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
            const recentCalls = await prisma.call.findMany({
              where: {
                createdAt: { gte: fiveMinutesAgo },
                recordingDurationSeconds: null, // Only calls without recording duration set
              },
              orderBy: { createdAt: 'desc' },
              take: 10,
            });

            if (recentCalls.length > 0) {
              // Take the most recent call as the match
              const matchedCall = recentCalls[0];
              console.log(`[RECORDING] Fallback matched call ${matchedCall.id} by timestamp`);

              await prisma.call.update({
                where: { id: matchedCall.id },
                data: {
                  twilioCallSid: CallSid,
                  durationSeconds,
                  recordingDurationSeconds: durationSeconds,
                  recordingUrl: RecordingSid,
                  recordingCompletedAt: completedAt,
                },
              });

              console.log(`[RECORDING] ✅ Updated call ${matchedCall.id} with recording duration: ${durationSeconds}s`);

              // Send notification email
              const call = await prisma.call.findFirst({
                where: { id: matchedCall.id },
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
                console.log(`[RECORDING] 📧 Sending notification email for fallback-matched call`);

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
