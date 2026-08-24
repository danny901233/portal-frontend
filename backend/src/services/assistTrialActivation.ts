// Everything that must happen once a self-serve Assist trial is genuinely live: buy the number,
// wire the SIP trunk, push the agent config, welcome the customer, move the HighLevel opportunity
// to "Free trial live", and tell the team.
//
// This used to live inside the Stripe setup_intent.succeeded handler alone. That handler never
// fired in production (the event was not reaching us), so accounts were being created by
// /api/public/signup-complete with NO number, NO agent config push, and NO ops alert — the team
// only found out a trial existed by noticing the row in the database.
//
// Both entry points now call activateAssistTrial():
//   • /api/public/signup-complete — the card form, the instant Stripe confirms the card
//   • setup_intent.succeeded      — the webhook, if/when it arrives
//
// Whichever runs first does the work; the other is a no-op. Idempotency is keyed on real state,
// not on a "done" flag we might forget to set:
//   • provisioning  → skipped when garage.twilioNumber is already set
//   • welcome + ops → skipped when garage.welcomeEmailSentAt is already set
import { prisma } from '../db.js';
import { purchaseRandomTwilioNumber } from '../routes/onboarding.js';
import { sendAgentConfigWebhook } from '../routes/config.js';
import { sendWelcomeEmail, sendEmail } from '../utils/email.js';
import { updateOpportunity, TRIAL_LIVE_STAGE_ID } from './highlevel.js';
import { sendOpsSms } from '../utils/opsAlerts.js';

const PORTAL_URL = process.env.PORTAL_URL || 'https://portal.receptionmate.co.uk';
const ONBOARDING_SERVICE_URL = process.env.ONBOARDING_SERVICE_URL || 'http://localhost:3002';
const ONBOARDING_SECRET = process.env.ONBOARDING_SECRET;
const OPS_EMAIL = 'hello@receptionmate.co.uk';

export interface ActivatableAccount {
  garageId: string;
  garageName: string;
  userEmail: string;
}

/**
 * Buy a Twilio number, provision the SIP trunk, push the agent config, and send the welcome
 * email. Idempotent by contract: the caller must skip this if the garage already has a number.
 */
export async function provisionGarageAccount(
  garage: { id: string; name: string },
  userEmail: string,
  logPrefix = '[ASSIST_ACTIVATE]',
): Promise<string | null> {
  // Match the portal voice webhook's routing: Assist/GarageHive garages run on LiveKit Account 2
  // with their own agent; everything else stays on Account 1. Get this wrong and the number rings
  // into a LiveKit project with no matching trunk — the call goes nowhere.
  const cfg = await prisma.agentConfiguration.findUnique({
    where: { garageId: garage.id },
    select: { agentScript: true },
  });
  const agentScript = cfg?.agentScript || 'receptionmate-agent';
  const account = agentScript === 'Assist-agent' || agentScript === 'GarageHive-agent' ? 'account2' : 'account1';

  let twilioNumber: string | null = null;
  try {
    twilioNumber = await purchaseRandomTwilioNumber();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (ONBOARDING_SECRET) headers['x-onboarding-secret'] = ONBOARDING_SECRET;
    const onboardResponse = await fetch(`${ONBOARDING_SERVICE_URL}/provision`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        garageId: garage.id,
        garageName: garage.name,
        branchName: garage.name,
        contactEmail: userEmail,
        twilioNumber,
        agentName: agentScript,
        account,
        triggeredAt: new Date().toISOString(),
      }),
    });
    if (!onboardResponse.ok) {
      const text = await onboardResponse.text().catch(() => '');
      throw new Error(`Onboarding service ${onboardResponse.status}: ${text.slice(0, 200)}`);
    }
    await prisma.garage.update({ where: { id: garage.id }, data: { twilioNumber } });
  } catch (err) {
    console.error(`${logPrefix} Twilio provisioning failed for garage=${garage.id}:`, err);
    twilioNumber = null;
    // Don't throw — the trial has started; the team can assign a number manually. The ops alert
    // below carries the failure so nobody has to notice it in a log.
  }

  // Push the garage's agent config to the live agent (DynamoDB). Self-serve signups never saved
  // config in the portal, so this is the FIRST push — without it the number rings but the agent
  // has no config to load and the call goes nowhere.
  try {
    await sendAgentConfigWebhook(garage.id);
  } catch (err) {
    console.error(`${logPrefix} agent config sync failed for garage=${garage.id}:`, err);
  }

  try {
    await sendWelcomeEmail({
      to: userEmail,
      businessName: garage.name,
      branchName: garage.name,
      email: userEmail,
      password: 'Nomoremissedcalls',
      portalUrl: PORTAL_URL,
    });
  } catch (err) {
    console.error(`${logPrefix} welcome email failed:`, err);
  }

  console.log(`${logPrefix} provisioned garage=${garage.id} twilio=${twilioNumber ?? 'FAILED'}`);
  return twilioNumber;
}

/**
 * Run the full post-signup activation for a self-serve Assist trial. Safe to call more than once
 * and from either entry point — each step guards on real state.
 */
export async function activateAssistTrial(
  created: ActivatableAccount,
  pending: { ghlOpportunityId?: string | null } | null,
  source: 'signup-complete' | 'webhook',
): Promise<void> {
  const logPrefix = `[ASSIST_ACTIVATE:${source}]`;

  const garage = await prisma.garage.findUnique({
    where: { id: created.garageId },
    select: { id: true, name: true, twilioNumber: true, welcomeEmailSentAt: true },
  });
  if (!garage) {
    console.error(`${logPrefix} garage ${created.garageId} vanished before activation`);
    return;
  }

  let twilioNumber = garage.twilioNumber;
  if (!twilioNumber) {
    twilioNumber = await provisionGarageAccount({ id: garage.id, name: garage.name }, created.userEmail, logPrefix);
  } else {
    console.log(`${logPrefix} garage=${garage.id} already has ${twilioNumber} — skipping provisioning`);
  }

  // The welcome email is sent inside provisionGarageAccount; welcomeEmailSentAt is what stops the
  // ops alert (and a second welcome) if the other entry point runs later.
  if (garage.welcomeEmailSentAt) {
    console.log(`${logPrefix} garage=${garage.id} already activated — skipping ops alert`);
    return;
  }
  await prisma.garage.update({ where: { id: garage.id }, data: { welcomeEmailSentAt: new Date() } });

  if (pending?.ghlOpportunityId && TRIAL_LIVE_STAGE_ID) {
    void updateOpportunity(pending.ghlOpportunityId, { stageId: TRIAL_LIVE_STAGE_ID, monetaryValueGbp: 200 })
      .then((ok) => console.log(`${logPrefix} HL opp ${pending.ghlOpportunityId} → Free trial live (${ok ? 'ok' : 'failed'})`))
      .catch(() => {});
  }

  // Ops alert — a real, carded trial signup. Carries the number so a provisioning failure is
  // visible in the alert itself rather than only in the logs.
  const numberLine = twilioNumber
    ? `Number: ${twilioNumber}`
    : 'Number: PROVISIONING FAILED — assign one manually';
  void sendEmail({
    to: [OPS_EMAIL],
    subject: `New Assist trial signup — ${created.garageName}`,
    text: `New Assist 14-day trial signup (card confirmed).\n\nBusiness: ${created.garageName}\nEmail: ${created.userEmail}\n${numberLine}`,
    html:
      `<p>New Assist 14-day trial signup 🎉 (card confirmed)</p>` +
      `<p>Business: <strong>${created.garageName}</strong><br/>Email: ${created.userEmail}<br/>${numberLine}</p>`,
  }).catch(() => {});
  void sendOpsSms(`New Assist trial signup 🎉\n${created.garageName}\n${created.userEmail}\n${numberLine}`);
}
