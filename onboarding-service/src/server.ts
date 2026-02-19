import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import { z } from 'zod';
import twilio from 'twilio';
import { SipClient } from 'livekit-server-sdk';

dotenv.config();

const app = express();
app.use(express.json());

// Validation schema for incoming activation requests
const activationPayloadSchema = z.object({
  garageId: z.string().uuid(),
  garageName: z.string(),
  branchName: z.string().nullable().optional(),
  contactEmail: z.string().email().nullable().optional(),
  contactPhone: z.string().nullable().optional(),
  twilioNumber: z.string(),
  agentName: z.string().nullable().optional(),
  triggeredAt: z.string(),
});

type ActivationPayload = z.infer<typeof activationPayloadSchema>;

// Twilio client
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// LiveKit SIP client
console.log('🔧 Initializing LiveKit SIP client with:', {
  url: process.env.LIVEKIT_URL,
  apiKey: process.env.LIVEKIT_API_KEY?.substring(0, 10) + '...',
});
const livekitSipClient = new SipClient(
  process.env.LIVEKIT_URL!,
  process.env.LIVEKIT_API_KEY!,
  process.env.LIVEKIT_API_SECRET!
);

// Health check endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'onboarding-service' });
});

// Main provisioning endpoint
app.post('/provision', async (req: Request, res: Response) => {
  try {
    // 1. Validate request
    const parsed = activationPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid payload',
        details: parsed.error.flatten(),
      });
    }

    const payload: ActivationPayload = parsed.data;
    console.log('Processing activation for garage:', payload.garageId, payload.garageName);

    // 2. Optional: Verify shared secret
    const providedSecret = req.headers['x-onboarding-secret'];
    const configuredSecret = process.env.ONBOARDING_SECRET;
    if (configuredSecret && providedSecret !== configuredSecret) {
      return res.status(401).json({ error: 'Invalid secret' });
    }

    // 3. Create LiveKit SIP trunk for this garage
    // Skip LiveKit trunk creation if credentials are invalid
    try {
      await createLiveKitSipTrunk(
        payload.garageId,
        payload.garageName,
        payload.twilioNumber,
        payload.agentName ?? undefined
      );
      console.log('✅ LiveKit SIP trunk created successfully');
    } catch (error) {
      console.warn('⚠️ LiveKit SIP trunk creation failed, skipping:', error instanceof Error ? error.message : 'Unknown error');
      // Continue with Twilio configuration even if LiveKit fails
    }

    // 4. Configure Twilio number to route to voice webhook
    await configureTwilioNumber(payload.twilioNumber, payload.garageId);

    // 5. Optional: Send notification email
    if (payload.contactEmail) {
      console.log('Would send activation email to:', payload.contactEmail);
      // await sendActivationEmail(payload.contactEmail, payload.garageName);
    }

    console.log('✅ Successfully provisioned garage:', payload.garageId);

    res.status(200).json({
      success: true,
      message: 'Garage activated successfully',
      garageId: payload.garageId,
      twilioNumber: payload.twilioNumber,
    });

  } catch (error) {
    console.error('Provisioning error:', error);
    res.status(500).json({
      error: 'Provisioning failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Update the agent name for an existing SIP dispatch rule
 */
app.post('/update-agent', async (req: Request, res: Response) => {
  try {
    const updateSchema = z.object({
      garageId: z.string().uuid(),
      agentName: z.string(),
    });

    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid payload',
        details: parsed.error.flatten(),
      });
    }

    // Verify shared secret
    const providedSecret = req.headers['x-onboarding-secret'];
    const configuredSecret = process.env.ONBOARDING_SECRET;
    if (configuredSecret && providedSecret !== configuredSecret) {
      return res.status(401).json({ error: 'Invalid secret' });
    }

    const { garageId, agentName } = parsed.data;
    console.log(`[UPDATE-AGENT] Updating dispatch rule for garage ${garageId} to agent: ${agentName}`);

    // List all dispatch rules and find the one for this garage
    const dispatchRules = await livekitSipClient.listSipDispatchRule();
    const targetRule = dispatchRules.find(rule => {
      const metadata = rule.metadata ? JSON.parse(rule.metadata) : {};
      return metadata.garageId === garageId;
    });

    if (!targetRule) {
      console.log(`[UPDATE-AGENT] No dispatch rule found for garage ${garageId}`);
      return res.status(404).json({ error: 'Dispatch rule not found for this garage' });
    }

    console.log(`[UPDATE-AGENT] Found rule ${targetRule.sipDispatchRuleId}, current agent: ${targetRule.roomConfig?.agents?.[0]?.agentName}`);

    // Update the dispatch rule with new agent name
    await livekitSipClient.updateSipDispatchRule(
      targetRule.sipDispatchRuleId,
      {
        ...targetRule,
        roomConfig: {
          ...targetRule.roomConfig,
          agents: [
            {
              agentName,
            },
          ],
        } as any,
      } as any
    );

    console.log(`✅ Updated dispatch rule ${targetRule.sipDispatchRuleId} to use agent: ${agentName}`);

    res.status(200).json({
      success: true,
      message: 'Agent updated successfully',
      garageId,
      agentName,
      dispatchRuleId: targetRule.sipDispatchRuleId,
    });

  } catch (error) {
    console.error('[UPDATE-AGENT] Error:', error);
    res.status(500).json({
      error: 'Failed to update agent',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Create a SIP trunk in LiveKit for this garage
 */
async function createLiveKitSipTrunk(
  garageId: string,
  garageName: string,
  twilioNumber: string,
  agentName?: string
): Promise<void> {
  try {
    console.log('Creating LiveKit SIP trunk for garage:', garageId);
    const dispatchAgentName =
      process.env.LIVEKIT_DISPATCH_AGENT_NAME?.trim() ||
      agentName?.trim() ||
      'receptionmate-agent';

    // Normalize phone number: remove +, spaces, and any other non-digit characters
    const normalizedPhoneNumber = twilioNumber.replace(/[\s\+\-\(\)]/g, '');

    // Create SIP inbound trunk with both garage ID and phone number as identifiers
    const trunk = await livekitSipClient.createSipInboundTrunk(
      `${garageName} (${garageId})`,
      [garageId, normalizedPhoneNumber],
      {
        krispEnabled: true,
        metadata: JSON.stringify({
          garageId,
          garageName,
          twilioNumber: normalizedPhoneNumber,
          createdAt: new Date().toISOString(),
        }),
      }
    );

    console.log(`✅ Created LiveKit SIP trunk:`, trunk.sipTrunkId);
    console.log(`   Trunk identifier: ${garageId}`);
    
    // Create SIP dispatch rule to route calls to your agent
    // Use a room prefix instead of static name to allow multiple concurrent calls
    const dispatchRule = await livekitSipClient.createSipDispatchRule(
      {
        type: 'individual',
        roomPrefix: `garage-${garageId}`,
        pin: '',
      },
      {
        name: `Route to ${garageName}`,
        trunkIds: [trunk.sipTrunkId],
        metadata: JSON.stringify({
          garageId,
          garageName,
        }),
        roomConfig: {
          agents: [
            {
              agentName: dispatchAgentName,
            },
          ],
        } as any,
      } as any
    );

    console.log(`✅ Created dispatch rule:`, dispatchRule.sipDispatchRuleId);

  } catch (error) {
    console.error('Failed to create LiveKit SIP trunk:', error);
    throw error;
  }
}

/**
 * Configure a Twilio phone number to route calls to the voice webhook
 */
async function configureTwilioNumber(phoneNumber: string, garageId: string): Promise<void> {
  try {
    console.log('Configuring Twilio number:', phoneNumber);

    // Find the phone number in your Twilio account
    const numbers = await twilioClient.incomingPhoneNumbers.list({
      phoneNumber: phoneNumber,
    });

    if (numbers.length === 0) {
      throw new Error(`Phone number ${phoneNumber} not found in Twilio account`);
    }

    const numberSid = numbers[0].sid;
    const portalBaseUrl = process.env.PORTAL_BASE_URL;

    if (!portalBaseUrl) {
      throw new Error('PORTAL_BASE_URL not configured');
    }

    // Build the webhook URL with garage ID
    const webhookUrl = `${portalBaseUrl}/webhooks/voice?garageId=${garageId}`;

    // Update the number's voice webhook
    await twilioClient.incomingPhoneNumbers(numberSid).update({
      voiceUrl: webhookUrl,
      voiceMethod: 'POST',
      friendlyName: `ReceptionMate - ${garageId}`,
    });

    console.log(`✅ Configured ${phoneNumber} to route to ${webhookUrl}`);
  } catch (error) {
    console.error('Failed to configure Twilio number:', error);
    throw error;
  }
}

/**
 * Optional: Send activation confirmation email
 * Uncomment and configure if you want email notifications
 */
// async function sendActivationEmail(email: string, garageName: string): Promise<void> {
//   // Implement using nodemailer or your preferred email service
//   console.log(`Sending activation email to ${email} for ${garageName}`);
// }

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`🚀 Onboarding service listening on port ${PORT}`);
  console.log(`Twilio Account SID: ${process.env.TWILIO_ACCOUNT_SID ? '✅ Configured' : '❌ Missing'}`);
  console.log(`LiveKit Agent URL: ${process.env.LIVEKIT_AGENT_URL || '❌ Not configured'}`);
  console.log(`Portal Base URL: ${process.env.PORTAL_BASE_URL || '❌ Not configured'}`);
});

export default app;
