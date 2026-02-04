import type { Request, Response } from 'express';
import { Router } from 'express';
import { prisma } from '../db.js';

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
      if (durationSeconds !== null && !Number.isNaN(durationSeconds)) {
        const updatedCalls = await prisma.call.updateMany({
          where: {
            twilioCallSid: CallSid,
            recordingUrl: null, // Only update calls that don't have recording yet
          },
          data: {
            durationSeconds,
            recordingDurationSeconds: durationSeconds,
            recordingUrl: RecordingSid,
            recordingCompletedAt: completedAt,
          },
        });

        if (updatedCalls.count > 0) {
          console.log(`[RECORDING] Updated ${updatedCalls.count} call(s) with recording duration: ${durationSeconds}s`);
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
