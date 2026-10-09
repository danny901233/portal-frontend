// Buy a garage its phone number and wire it up, at the moment it goes live.
//
// WHY HERE AND NOT AT SIGNING.
//
// Self-serve signup (the Blend show funnel) creates a signed agreement from an unverified form,
// so buying a number at signature means anybody who signs costs us one. Go-live cannot be reached
// without the garage's GMS returning API credentials, which is a third party confirming the
// garage exists — the verification the signup itself does not have. It is also the first moment
// the number is of any use: until the diary is connected the agent cannot book, and the customer
// has nothing to forward their line to.
//
// WHAT HAS TO HAPPEN, IN ORDER.
//
// Buying a number is the easy part and on its own produces a number that rings out. The call
// also has to reach an agent:
//   1. buy the number at Twilio
//   2. /provision — points the number at our /voice webhook and makes the Account 1 SIP trunk
//   3. ensureUnifiedSipRouting — the unified agent lives in its OWN LiveKit project, which
//      /provision does not manage. Every garage from the show funnel runs unified-agent, so
//      skipping this gives a number that is configured correctly at Twilio, resolves the right
//      SIP domain, and then rings out because nothing accepts the call.
//
// The caller must treat a failure as "do not announce go-live". A customer told to forward their
// calls to a number that rings out is worse off than one still waiting, and they cannot tell the
// difference from the outside — so a failure alerts us instead of emailing them.

import { prisma } from '../db.js';
import { purchaseRandomTwilioNumber } from '../routes/onboarding.js';
import { ensureUnifiedSipRouting } from './unifiedSip.js';
import { accountForAgentScript } from '../utils/agentAccount.js';
import { sendEmail } from '../utils/email.js';

// A tagged result, NOT an ok/reason pair.
//
// go-live has to tell three different outcomes apart: it got a number, it does not need one
// (Connect-only), or it failed. Expressing "does not need one" as a failure meant the caller
// decided whether to continue by string-matching the reason — so editing that sentence would
// have silently started announcing voice garages with no number, and nothing would have failed.
export type ProvisionResult =
  | { status: 'provisioned'; twilioNumber: string }
  | { status: 'already_had'; twilioNumber: string }
  | { status: 'not_required' }
  | { status: 'failed'; reason: string; twilioNumber?: string };

// One purchase at a time per garage.
//
// announceGoLiveIfReady is called from BOTH onboarding tracks on purpose — "whichever finishes
// last calls this" — so an agreement signed at the same moment the diary connects can enter here
// twice. Both would pass the "has a number?" check and buy one, and the second is a number we pay
// for that nothing points at. Callers share the first call's promise instead.
const inFlight = new Map<string, Promise<ProvisionResult>>();

/**
 * The agent worker name the onboarding service should wire, from the garage's script.
 *
 * Must agree with the ladder in /admin/onboard: a garage provisioned here and one onboarded by
 * staff have to end up pointing at the same worker, or the number resolves to an agent that is
 * not the one its config describes and the call is answered by the wrong script.
 */
export function agentNameFor(script: string | null | undefined): string {
  const known = [
    'unified-agent',
    'tyresoft-agent',
    'receptionmate-agent-v3',
    'MMH-agent',
    'bookar-agent',
    'Assist-agent',
    'GarageHive-agent',
  ];
  return known.includes(String(script)) ? String(script) : 'receptionmate-agent';
}

/**
 * Make sure `garageId` has a working number. Idempotent: a garage that already has one is left
 * alone, so this is safe to call from a path that may run more than once.
 */
export function provisionNumberForGarage(garageId: string): Promise<ProvisionResult> {
  const running = inFlight.get(garageId);
  if (running) return running;
  const p = doProvision(garageId).finally(() => inFlight.delete(garageId));
  inFlight.set(garageId, p);
  return p;
}

async function doProvision(garageId: string): Promise<ProvisionResult> {
  const garage = await prisma.garage.findUnique({
    where: { id: garageId },
    select: {
      id: true,
      name: true,
      twilioNumber: true,
      hasVoiceAccess: true,
      agentConfiguration: { select: { agentScript: true } },
    },
  });
  if (!garage) return { status: 'failed', reason: 'garage not found' };

  // Already sorted. Not an error — go-live can run more than once.
  if (garage.twilioNumber) {
    return { status: 'already_had', twilioNumber: garage.twilioNumber };
  }

  // A Connect-only branch buys messaging, not a phone line. Nothing to do, and nothing wrong.
  if (!garage.hasVoiceAccess) {
    return { status: 'not_required' };
  }

  const script = garage.agentConfiguration?.agentScript ?? null;

  let twilioNumber: string;
  try {
    twilioNumber = await purchaseRandomTwilioNumber();
  } catch (err) {
    // The usual cause is a regulatory bundle: a UK number type we hold no bundle for is refused
    // at purchase. There is nothing the customer can do about it and nothing to retry blindly.
    return { status: 'failed', reason: `Twilio purchase failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Persist it the instant it is ours, BEFORE any wiring. A crash between buying and recording
  // would otherwise leave us paying for a number nothing references, and the retry would buy a
  // second one; recording it first also makes the "has a number?" check above a real guard for
  // anything that comes along later.
  await prisma.garage.update({ where: { id: garageId }, data: { twilioNumber } });

  const onboardingUrl = process.env.ONBOARDING_SERVICE_URL || 'http://localhost:3002';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (process.env.ONBOARDING_SECRET) headers['x-onboarding-secret'] = process.env.ONBOARDING_SECRET;

  try {
    const resp = await fetch(`${onboardingUrl}/provision`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        garageId: garage.id,
        garageName: garage.name,
        branchName: garage.name,
        twilioNumber,
        agentName: agentNameFor(script),
        account: accountForAgentScript(script),
        triggeredAt: new Date().toISOString(),
      }),
    });
    if (!resp.ok) {
      return { status: 'failed', reason: `provision failed: ${await resp.text()}`, twilioNumber };
    }
  } catch (err) {
    return {
      status: 'failed',
      reason: `provision unreachable: ${err instanceof Error ? err.message : String(err)}`,
      twilioNumber,
    };
  }

  // The unified agent's own LiveKit project. Without this the number is correct at Twilio and
  // the call still rings out, which looks identical to the customer and nothing else reports it.
  if (script === 'unified-agent') {
    const wired = await ensureUnifiedSipRouting({
      garageId: garage.id,
      garageName: garage.name,
      twilioNumber,
    });
    if (!wired.ok) {
      return { status: 'failed', reason: `unified SIP trunk not created: ${wired.reason}`, twilioNumber };
    }
  }

  console.log(`[PROVISION] ${garage.name} -> ${twilioNumber} (${agentNameFor(script)})`);
  return { status: 'provisioned', twilioNumber };
}

/**
 * Tell US, not the customer, that a garage is ready to go live but has no working number.
 *
 * Deliberately never sent to the garage: they would be told to forward their calls to a line that
 * rings out, and that is indistinguishable from us having done nothing.
 */
export async function alertNumberProvisioningFailed(
  garageName: string,
  garageId: string,
  reason: string,
  twilioNumber?: string,
): Promise<void> {
  const to = (process.env.OPS_ALERT_EMAIL_TO || process.env.GARAGEHIVE_CONNECT_EMAIL_CC || 'hello@receptionmate.co.uk')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  const body =
    `${garageName} is ready to go live — the agreement is signed and the diary is connected — ` +
    `but it has no working phone number, so the go-live email has NOT been sent.\n\n` +
    `Reason: ${reason}\n` +
    (twilioNumber ? `A number WAS purchased (${twilioNumber}) and may need wiring by hand.\n` : 'No number was purchased.\n') +
    `\nGarage: ${garageName} (${garageId})\n\n` +
    `Go-live will retry on its own the next time the garage is touched, so fixing the cause is ` +
    `usually enough. The customer has not been told anything.`;
  await sendEmail({
    to,
    subject: `Go-live blocked: ${garageName} has no working number`,
    text: body,
    html: `<pre style="font-family:inherit;white-space:pre-wrap">${body
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')}</pre>`,
    template: 'ops_number_provisioning_failed',
  }).catch((e) => console.error('[PROVISION] could not send the failure alert:', e));
}
