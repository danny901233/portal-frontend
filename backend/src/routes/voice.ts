import type { Request, Response } from 'express';
import { Router } from 'express';
import { prisma } from '../db.js';

// Global type for Twilio recording storage
declare global {
  var twilioRecordings: Map<string, {
    recordingSid: string;
    recordingUrl: string;
    duration: string;
    completedAt: string;
  }> | undefined;
}

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

    if (agentConfig?.agentType === 'automate') {
      agentType = 'automate';
    }
  } catch (error) {
    console.error('[VOICE] Error loading agent type for garage', garageId, error);
  }

  // Always dial the unified LiveKit SIP domain; behaviour differences happen inside the agent codepath
  const livekitSipDomain =
    process.env.LIVEKIT_SIP_DOMAIN ||
    process.env.LIVEKIT_SIP_DOMAIN_AUTOMATE ||
    process.env.LIVEKIT_SIP_DOMAIN_ASSIST ||
    'n4s20ufg0v7.sip.livekit.cloud';

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
    
    if (RecordingStatus === 'completed' && RecordingUrl) {
      console.log(`[RECORDING] ✅ Recording completed:`);
      console.log(`[RECORDING]    CallSid: ${CallSid}`);
      console.log(`[RECORDING]    RecordingSid: ${RecordingSid}`);
      console.log(`[RECORDING]    RecordingUrl: ${RecordingUrl}`);
      console.log(`[RECORDING]    Duration: ${RecordingDuration}s`);
      
      // Store in global map for agent to retrieve
      // We'll use CallSid as the key since that's available in both webhooks
      global.twilioRecordings = global.twilioRecordings || new Map();
      global.twilioRecordings.set(CallSid, {
        recordingSid: RecordingSid,
        recordingUrl: RecordingUrl,
        duration: RecordingDuration,
        completedAt: new Date().toISOString()
      });
    }
    
    res.status(200).send('OK');
  } catch (error) {
    console.error('[RECORDING] Error processing recording callback:', error);
    res.status(500).send('Error');
  }
});

export default router;
