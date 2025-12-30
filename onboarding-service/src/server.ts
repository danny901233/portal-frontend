import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import { z } from 'zod';
import twilio from 'twilio';

dotenv.config();

const app = express();
app.use(express.json());

// Validation schema for incoming activation requests
const activationPayloadSchema = z.object({
  garageId: z.string().uuid(),
  garageName: z.string(),
  branchName: z.string().nullable(),
  contactEmail: z.string().email().nullable(),
  contactPhone: z.string().nullable(),
  twilioNumber: z.string(),
  triggeredAt: z.string(),
});

type ActivationPayload = z.infer<typeof activationPayloadSchema>;

// Twilio client
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
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

    // 3. Configure Twilio number
    await configureTwilioNumber(payload.twilioNumber);

    // 4. Optionally trigger LiveKit agent deployment/configuration
    // This depends on your LiveKit setup - you might:
    // - Call LiveKit API to create rooms
    // - Trigger a deployment pipeline
    // - Update agent configuration
    // For now, we'll log it
    console.log('LiveKit agent should pull config from:', 
      `${process.env.PORTAL_BASE_URL}/api/config/${payload.garageId}`);

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
 * Configure a Twilio phone number to route calls to the LiveKit agent
 */
async function configureTwilioNumber(phoneNumber: string): Promise<void> {
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
    const agentUrl = process.env.LIVEKIT_AGENT_URL;

    if (!agentUrl) {
      throw new Error('LIVEKIT_AGENT_URL not configured');
    }

    // Update the number's voice webhook
    await twilioClient.incomingPhoneNumbers(numberSid).update({
      voiceUrl: agentUrl,
      voiceMethod: 'POST',
      statusCallback: `${agentUrl}/status`,
      statusCallbackMethod: 'POST',
    });

    console.log(`✅ Configured ${phoneNumber} to route to ${agentUrl}`);
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
