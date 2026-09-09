// Inbound SIP wiring for the unified agent.
//
// The unified agent runs in its OWN LiveKit project (receptionmate-automotive), which the
// onboarding service does not manage — that one provisions trunks on Account 1. So a garage
// onboarded onto the unified agent got a Twilio number pointed correctly at /voice, /voice
// resolved the right SIP domain, and then the call arrived at a project with no trunk accepting
// it and nothing answered. Every unified garage on the estate had its trunk made by hand.
//
// This creates the same pair the hand-made ones are: an inbound trunk carrying the garage id and
// number, and an "individual" dispatch rule naming the unified-agent so a worker actually joins.
// A named agent needs roomConfig.agents — without it the room is created and nobody arrives.
import { SipClient } from 'livekit-server-sdk';
import { RoomAgentDispatch, RoomConfiguration } from '@livekit/protocol';

const UNIFIED_AGENT_NAME = 'unified-agent';

const config = () => {
  const url = process.env.LIVEKIT_UNIFIED_URL;
  const key = process.env.LIVEKIT_UNIFIED_API_KEY;
  const secret = process.env.LIVEKIT_UNIFIED_API_SECRET;
  return url && key && secret ? { url, key, secret } : null;
};

export const unifiedSipConfigured = (): boolean => config() !== null;

/**
 * Give a garage its inbound trunk + dispatch rule in the unified project.
 *
 * Idempotent: an existing trunk carrying this garage id is left alone, so re-running onboarding
 * or re-provisioning a number cannot produce two trunks answering the same calls.
 *
 * Never throws — onboarding must not fail because this step did. Returns what happened so the
 * caller can log it.
 */
export async function ensureUnifiedSipRouting(args: {
  garageId: string;
  garageName: string;
  twilioNumber: string;
}): Promise<{ ok: boolean; trunkId?: string; ruleId?: string; reason?: string }> {
  const cfg = config();
  if (!cfg) {
    console.warn(
      '[UNIFIED_SIP] LIVEKIT_UNIFIED_* not configured — no trunk created for',
      args.garageId,
      '(calls to this number will ring out)',
    );
    return { ok: false, reason: 'not configured' };
  }
  const { garageId, garageName, twilioNumber } = args;
  try {
    const sip = new SipClient(cfg.url, cfg.key, cfg.secret);

    // Already wired? The garage id is carried as a "number" on the trunk precisely so it can be
    // found again — the hand-made trunks all do this, and /voice dials the garage id as the user.
    const existing = await sip.listSipInboundTrunk();
    const already = existing.find((t) => (t.numbers ?? []).includes(garageId));
    if (already) {
      console.log(`[UNIFIED_SIP] ${garageName} already has trunk ${already.sipTrunkId} — leaving it`);
      return { ok: true, trunkId: already.sipTrunkId, reason: 'already existed' };
    }

    // Match the hand-made trunks: the garage id plus the number in the formats a carrier may
    // present it in. LiveKit matches on any of them.
    const numbers = [garageId, twilioNumber, twilioNumber.replace(/^\+/, '')];
    if (twilioNumber.startsWith('+44')) numbers.push(`0${twilioNumber.slice(3)}`);

    const trunk = await sip.createSipInboundTrunk(`${garageName} (unified-agent)`, numbers, {
      metadata: JSON.stringify({ garageId, garageName, note: 'unified-agent — created at onboarding' }),
    });

    // "Individual" so each caller gets their own room, named the way the agent and the portal
    // both expect: garage-<garageId>_<caller>_<random>.
    const rule = await sip.createSipDispatchRule(
      { type: 'individual', roomPrefix: `garage-${garageId}` },
      {
        name: `Route to ${garageName} (unified-agent)`,
        trunkIds: [trunk.sipTrunkId],
        // Without this the room is created and no worker joins: the agent is a NAMED agent, so
        // it is only dispatched when the rule asks for it explicitly.
        roomConfig: new RoomConfiguration({
          agents: [new RoomAgentDispatch({ agentName: UNIFIED_AGENT_NAME })],
        }),
      },
    );
    console.log(
      `[UNIFIED_SIP] ${garageName}: trunk ${trunk.sipTrunkId} + rule ${rule.sipDispatchRuleId} for ${twilioNumber}`,
    );
    return { ok: true, trunkId: trunk.sipTrunkId, ruleId: rule.sipDispatchRuleId };
  } catch (err) {
    console.error('[UNIFIED_SIP] failed to wire', args.garageId, err);
    return { ok: false, reason: err instanceof Error ? err.message : 'unknown error' };
  }
}
