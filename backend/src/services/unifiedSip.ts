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
const SUPERVISOR_AGENT_NAME = 'supervisor-agent';

/**
 * Which worker should join this garage's rooms.
 *
 * The supervisor agent replaces the unified one and runs in the SAME project off the SAME
 * inbound trunk, so the dispatch rule's agent name is the only thing that moves a garage
 * between them. Anything we do not recognise stays on the unified worker, which is today's
 * behaviour — a garage must never end up on a worker because of a typo.
 */
export function dispatchAgentName(agentScript?: string | null): string {
  return (agentScript || '').trim() === SUPERVISOR_AGENT_NAME
    ? SUPERVISOR_AGENT_NAME
    : UNIFIED_AGENT_NAME;
}

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
  /** From AgentConfiguration.agentScript. Omitted = the unified worker, as before. */
  agentScript?: string | null;
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
    //
    // NORMALISE FIRST. Garage.twilioNumber is stored for display — "+44 333 041 1784" — and a
    // carrier never presents it that way, so passing it through verbatim put four numbers on the
    // trunk of which three had spaces in and none was the E.164 the INVITE actually carries. The
    // demo line was wired that way on 2026-10-01; every hand-made trunk has clean digits.
    const e164 = twilioNumber.replace(/[^\d+]/g, '');
    const numbers = [garageId, e164, e164.replace(/^\+/, '')];
    if (e164.startsWith('+44')) numbers.push(`0${e164.slice(3)}`);

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
          agents: [new RoomAgentDispatch({ agentName: dispatchAgentName(args.agentScript) })],
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

// ── Switching an existing garage between the unified and supervisor workers ─────────────────
//
// Dan, 4 Nov 2026: "we want it in the portal so we can switch between supervisor or unified".
// ensureUnifiedSipRouting only names the worker when it CREATES a rule, so changing agentScript
// on a garage that already had one moved nothing: the portal said supervisor and the calls went
// to unified. The dispatch rule's agent name is the switch, so a save now moves it.

const SWITCHABLE = new Set([UNIFIED_AGENT_NAME, SUPERVISOR_AGENT_NAME]);

type RuleLike = {
  sipDispatchRuleId?: string;
  name?: string;
  rule?: { rule?: { value?: { roomPrefix?: string } } };
  roomConfig?: { agents?: { agentName: string }[] };
};

/** The room prefix of an individual dispatch rule. The oneof sits at rule.rule as {case, value}. */
export function rulePrefix(r: RuleLike): string {
  return r?.rule?.rule?.value?.roomPrefix ?? '';
}

/** "Route to X (unified-agent)" -> "Route to X (supervisor-agent)"; other names are kept. */
export function renameForAgent(name: string, agentName: string): string {
  return /\((unified-agent|supervisor-agent)\)/.test(name)
    ? name.replace(/\((unified-agent|supervisor-agent)\)/, `(${agentName})`)
    : name;
}

/**
 * Point a rule at `agentName`, editing the existing protobuf entry IN PLACE — a plain
 * `{agentName}` object fails to serialise ("value[i].toJson is not a function"). Only a rule
 * already serving the unified or supervisor worker is ever moved; anything else is refused.
 */
export function retargetRule(r: RuleLike, agentName: string): { changed: boolean; from: string; refused?: true } {
  const agents = r?.roomConfig?.agents ?? [];
  const from = agents[0]?.agentName ?? '';
  if (!agents.length || !SWITCHABLE.has(from)) return { changed: false, from, refused: true };
  if (from === agentName) return { changed: false, from };
  agents[0].agentName = agentName;
  if (r.name) r.name = renameForAgent(r.name, agentName);
  return { changed: true, from };
}

/**
 * Move a garage's existing dispatch rule to the worker its agentScript names. Idempotent and
 * never throws — a config save must not fail because this step did.
 */
export async function setUnifiedDispatchAgent(
  garageId: string,
  agentScript?: string | null,
): Promise<{ ok: boolean; ruleId?: string; from?: string; to?: string; reason?: string }> {
  const cfg = config();
  if (!cfg) return { ok: false, reason: 'not configured' };
  const want = dispatchAgentName(agentScript);
  try {
    const sip = new SipClient(cfg.url, cfg.key, cfg.secret);
    const rules = await sip.listSipDispatchRule();
    const rule = rules.find((r) => rulePrefix(r as unknown as RuleLike) === `garage-${garageId}`);
    if (!rule) return { ok: false, reason: 'no dispatch rule for this garage in the unified project' };
    const res = retargetRule(rule as unknown as RuleLike, want);
    if (res.refused) return { ok: false, ruleId: rule.sipDispatchRuleId, from: res.from, reason: 'rule serves another agent' };
    if (!res.changed) return { ok: true, ruleId: rule.sipDispatchRuleId, from: res.from, to: want, reason: 'already' };
    await sip.updateSipDispatchRule(rule.sipDispatchRuleId, rule);
    console.log(`[UNIFIED_SIP] ${garageId}: rule ${rule.sipDispatchRuleId} ${res.from} -> ${want}`);
    return { ok: true, ruleId: rule.sipDispatchRuleId, from: res.from, to: want };
  } catch (err) {
    console.error('[UNIFIED_SIP] failed to switch', garageId, err);
    return { ok: false, reason: err instanceof Error ? err.message : 'unknown error' };
  }
}
