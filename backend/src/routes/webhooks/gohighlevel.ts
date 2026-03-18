import type { Request, Response } from 'express';
import { Router } from 'express';
import crypto from 'crypto';
import axios from 'axios';

const router = Router();

const GHL_WEBHOOK_SECRET  = process.env.GHL_WEBHOOK_SECRET  || '';
const GHL_API_KEY         = process.env.GHL_API_KEY         || '';
const GHL_PIPELINE_ID     = process.env.GHL_PIPELINE_ID     || '';
const GHL_CREDENTIALS_EMAIL = process.env.GHL_CREDENTIALS_EMAIL || '';
const ONBOARDING_API_KEY  = process.env.ONBOARDING_API_KEY  || '';
const BASE_URL            = process.env.NEXT_PUBLIC_API_URL  || 'http://localhost:4000';

// Pipeline stage names (must match GoHighLevel exactly)
const STAGES = {
  SAAS_AGREEMENT_SENT:          'SAAS Agreement Sent',
  CREDENTIALS_REQUESTED:        'Contract Signed - Automate - Credentials Requested',
  GH_DETAILS_RECEIVED:          'GH Integration Details Received - Account Setup',
  CONTRACT_SIGNED_ASSIST:       'Contract Signed - Assist Setup',
  LIVE:                         'Live £££',
  LIVE_ASSIST:                  'Live',
};

// ─── Signature verification ──────────────────────────────────────────────────

function verifySignature(payload: string, signature: string): boolean {
  if (!GHL_WEBHOOK_SECRET) {
    console.warn('[GHL] GHL_WEBHOOK_SECRET not set — skipping verification');
    return true;
  }
  const expected = crypto
    .createHmac('sha256', GHL_WEBHOOK_SECRET)
    .update(payload)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ─── GHL API helpers ─────────────────────────────────────────────────────────

async function moveToStage(contactId: string, stageName: string): Promise<void> {
  if (!GHL_API_KEY || !GHL_PIPELINE_ID) {
    console.warn('[GHL] Missing GHL_API_KEY or GHL_PIPELINE_ID — cannot move stage');
    return;
  }
  try {
    // Get pipeline stages to find the stageId
    const pipelineResp = await axios.get(
      `https://rest.gohighlevel.com/v1/pipelines/${GHL_PIPELINE_ID}`,
      { headers: { Authorization: `Bearer ${GHL_API_KEY}` } }
    );
    const stages: any[] = pipelineResp.data?.stages || [];
    const stage = stages.find((s: any) => s.name === stageName);
    if (!stage) {
      console.error(`[GHL] Stage not found: "${stageName}"`);
      return;
    }
    await axios.put(
      `https://rest.gohighlevel.com/v1/contacts/${contactId}/pipeline`,
      { pipelineId: GHL_PIPELINE_ID, stageId: stage.id },
      { headers: { Authorization: `Bearer ${GHL_API_KEY}` } }
    );
    console.log(`[GHL] Moved contact ${contactId} to stage: ${stageName}`);
  } catch (err: any) {
    console.error('[GHL] Failed to move stage:', err.response?.data || err.message);
  }
}

async function sendCredentialsRequestEmail(contact: any): Promise<void> {
  if (!GHL_CREDENTIALS_EMAIL) {
    console.warn('[GHL] GHL_CREDENTIALS_EMAIL not set — skipping email');
    return;
  }
  // Reuse the portal's email utility indirectly via a simple log for now
  // In production this should call sendEmail() from utils/email.ts
  console.log(`[GHL] TODO: Send credentials request email to ${GHL_CREDENTIALS_EMAIL} for contact: ${contact.email} (${contact.name})`);
}

async function triggerOnboarding(contact: any, agentType: 'assist' | 'automate'): Promise<boolean> {
  if (!ONBOARDING_API_KEY) {
    console.error('[GHL] ONBOARDING_API_KEY not set — cannot trigger onboarding');
    return false;
  }
  try {
    const payload = {
      branchName:          contact.companyName || contact.name,
      contactName:         contact.name,
      contactEmail:        contact.email,
      websiteUrl:          contact.website || `https://example.com`,
      agentType,
      subscriptionCostGbp: agentType === 'automate' ? 299 : 149,
      includedMinutes:     400,
      trialType:           'days',
      trialDays:           14,
      autoPurchaseTwilioNumber: true,
      activateTwilio:      true,
    };
    console.log(`[GHL] Triggering onboarding for ${contact.email} (${agentType})`);
    const resp = await axios.post(
      `${BASE_URL}/api/onboarding/create-business`,
      payload,
      { headers: { 'X-API-Key': ONBOARDING_API_KEY }, timeout: 60000 }
    );
    console.log(`[GHL] Onboarding success: garageId=${resp.data?.garageId}`);
    return true;
  } catch (err: any) {
    console.error('[GHL] Onboarding failed:', err.response?.data || err.message);
    return false;
  }
}

// ─── Stage handlers ───────────────────────────────────────────────────────────

async function handleSaasAgreementSent(contact: any): Promise<void> {
  // Step 4 (Automate): Send credentials request email to GarageHive, advance stage
  console.log(`[GHL] Step 4 — SAAS Agreement Sent for ${contact.email}`);
  await sendCredentialsRequestEmail(contact);
  await moveToStage(contact.id, STAGES.CREDENTIALS_REQUESTED);
}

async function handleGHDetailsReceived(contact: any): Promise<void> {
  // Step 6 (Automate): Credentials received — create account
  console.log(`[GHL] Step 6 — GH Details Received for ${contact.email}`);
  const ok = await triggerOnboarding(contact, 'automate');
  if (ok) {
    await moveToStage(contact.id, STAGES.LIVE);
  } else {
    console.error(`[GHL] Onboarding failed for ${contact.email} — staying in current stage`);
  }
}

async function handleContractSignedAssist(contact: any): Promise<void> {
  // Step 5 (Assist): Contract signed — create account immediately
  console.log(`[GHL] Step 5 — Contract Signed (Assist) for ${contact.email}`);
  const ok = await triggerOnboarding(contact, 'assist');
  if (ok) {
    await moveToStage(contact.id, STAGES.LIVE_ASSIST);
  } else {
    console.error(`[GHL] Onboarding failed for ${contact.email} — staying in current stage`);
  }
}

// ─── Webhook endpoint ─────────────────────────────────────────────────────────

router.post('/webhooks/gohighlevel', async (req: Request, res: Response) => {
  const rawBody = (req as any).rawBody || JSON.stringify(req.body);
  const signature = req.headers['x-ghl-signature'] as string || '';

  if (!verifySignature(rawBody, signature)) {
    console.warn('[GHL] Invalid signature — rejecting webhook');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const { type, contact, pipeline } = req.body;

  if (type !== 'PipelineStageChanged') {
    return res.status(200).json({ received: true });
  }

  const stageName: string = pipeline?.stageName || '';
  console.log(`[GHL] Pipeline stage change: "${stageName}" for contact: ${contact?.email}`);

  // Respond immediately so GHL doesn't retry
  res.status(200).json({ received: true });

  // Handle stage async
  try {
    switch (stageName) {
      case STAGES.SAAS_AGREEMENT_SENT:
        await handleSaasAgreementSent(contact);
        break;
      case STAGES.GH_DETAILS_RECEIVED:
        await handleGHDetailsReceived(contact);
        break;
      case STAGES.CONTRACT_SIGNED_ASSIST:
        await handleContractSignedAssist(contact);
        break;
      default:
        console.log(`[GHL] Unhandled stage: "${stageName}" — no action taken`);
    }
  } catch (err: any) {
    console.error('[GHL] Handler error:', err.message);
  }
});

export default router;
