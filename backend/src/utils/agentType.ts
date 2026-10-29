/**
 * agentType, derived from the agent script. The script is the single source of truth.
 *
 * Only the Assist agent is message-only; every other script books. The save path in
 * routes/config.ts has derived it this way since the drift that mis-routed Assist garages to a
 * dead LiveKit account — but CREATE never did. The column simply defaults:
 *
 *     agentType String @default("assist")     // prisma/schema.prisma
 *
 * and no onboarding path writes it, so every garage is born "assist" whatever was sold. Quick
 * Onboard collects the licence and puts it on the AGREEMENT (`licences: ['automate']`) and sends
 * no agentType at all, which is why VICPros AutoCentre read back as Assist on 29 Oct 2026 after
 * Automate was explicitly picked — and why Woodyard Garage Redditch, a Bookar garage, says the
 * same thing.
 *
 * Mostly cosmetic today, which is why it went unnoticed: integrationProvider picks the diary,
 * chatAgentRouter deliberately overrides agentType when GarageHive credentials exist ("a garage
 * with a real diary must never be diverted to the Assist agent, even if agentType is
 * mislabeled"), and the unified agent only logs it. It is wrong in admin listings and in the
 * onboarding pipeline view, and it is the kind of field that acquires behaviour later.
 *
 * So: one rule, in one place, called by everything that writes the column.
 */
export type AgentType = 'assist' | 'automate';

/** The Assist script, as stored. */
const ASSIST_SCRIPT = 'Assist-agent';

export const agentTypeForScript = (agentScript: string | null | undefined): AgentType =>
  (agentScript ?? '').trim() === ASSIST_SCRIPT ? 'assist' : 'automate';
