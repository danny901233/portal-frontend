import { prisma } from '../db.js';
import {
  updateOpportunity,
  HL_AWAITING_CREDENTIALS_STAGE_ID,
  HL_AGENT_BUILT_STAGE_ID,
  HL_INVITED_STAGE_ID,
  LIVE_STAGE_ID,
} from '../services/highlevel.js';

// RECOVERED 2026-09-09 from dist/utils/onboardingStage.js. Source was never committed and went
// with the rest of the sales-pipeline feature when the box became a clean checkout in August.

export const ONBOARDING_STAGES = [
  'awaiting_agreement',
  'awaiting_credentials',
  'agent_built',
  'invited',
  'mandate_pending',
  'live',
] as const;
export type OnboardingStage = (typeof ONBOARDING_STAGES)[number];

// Portal stage -> HighLevel stage, using the stages the pipeline already had. Stages with no
// entry (awaiting_agreement, mandate_pending) deliberately don't move HL: "Contract Sent" is set
// by whoever sends the agreement, and mandate_pending is a portal-side waiting room that sales
// don't need to see — the deal is still "Invited" to them until it goes live.
const HL_STAGE_FOR: Partial<Record<OnboardingStage, string>> = {
  awaiting_credentials: HL_AWAITING_CREDENTIALS_STAGE_ID, // "Awaiting Integration Credentials"
  agent_built: HL_AGENT_BUILT_STAGE_ID, // "Agent Account Setup, awaiting go live date"
  invited: HL_INVITED_STAGE_ID, // "Invited — awaiting DD mandate"
  live: LIVE_STAGE_ID, // "Live and £££££"
};

type StageOpts = { reason?: string; monetaryValueGbp?: number };

/**
 * Move one garage to `stage` and mirror it into HighLevel.
 *
 * Never throws and never blocks: every caller is on a customer's critical path (signing,
 * confirming a mandate), so a CRM hiccup must not surface as a failed request. The HL call is
 * fire-and-forget and updateOpportunity already logs-and-returns rather than throwing.
 *
 * Garages already at 'live' are left alone entirely — that's every pre-existing garage on the
 * estate (they default to 'live'), and they must not be dragged into the pipeline or have their
 * HL opportunity rewritten by, say, an unrelated mandate change.
 */
export async function setOnboardingStage(
  garageId: string,
  stage: OnboardingStage,
  opts?: StageOpts,
): Promise<void> {
  try {
    const garage = await prisma.garage.findUnique({
      where: { id: garageId },
      select: {
        id: true,
        name: true,
        onboardingStage: true,
        ghlOpportunityId: true,
        onboardingStageAt: true,
      },
    });
    if (!garage) return;
    if (garage.onboardingStage === 'live') return; // already onboarded — not ours to touch
    if (garage.onboardingStage === stage) return; // no-op
    // Record WHEN this stage was entered. Merge rather than replace: the map is the garage's
    // whole history, and an earlier stage's time must survive later moves. Guarded above by the
    // same-stage early return, so this only ever writes a stage's FIRST entry.
    // Every value is an ISO timestamp, so narrow to string rather than unknown — Prisma's JSON
    // input type won't accept a Record<string, unknown>.
    const existingAt: Record<string, string> = {};
    if (
      garage.onboardingStageAt &&
      typeof garage.onboardingStageAt === 'object' &&
      !Array.isArray(garage.onboardingStageAt)
    ) {
      for (const [k, v] of Object.entries(garage.onboardingStageAt as Record<string, unknown>)) {
        if (typeof v === 'string') existingAt[k] = v;
      }
    }
    const stampedAt: Record<string, string> = { ...existingAt, [stage]: new Date().toISOString() };
    await prisma.garage.update({
      where: { id: garageId },
      data: { onboardingStage: stage, onboardingStageAt: stampedAt },
    });
    console.log(
      `[PIPELINE] ${garage.name}: ${garage.onboardingStage} -> ${stage}${opts?.reason ? ` (${opts.reason})` : ''}`,
    );
    const hlStage = HL_STAGE_FOR[stage];
    if (!garage.ghlOpportunityId || !hlStage) return; // not linked, or stage id not configured
    void updateOpportunity(garage.ghlOpportunityId, {
      stageId: hlStage,
      ...(typeof opts?.monetaryValueGbp === 'number'
        ? { monetaryValueGbp: opts.monetaryValueGbp }
        : {}),
    }).then((ok) =>
      console.log(`[PIPELINE] HL opp ${garage.ghlOpportunityId} -> ${stage} (${ok ? 'ok' : 'failed'})`),
    );
  } catch (err) {
    console.error(`[PIPELINE] setOnboardingStage(${garageId}, ${stage}) failed:`, err);
  }
}

/**
 * Same, for every in-flight garage a user owns. Used by confirm-mandate, which is user-scoped —
 * a multi-branch business completes one mandate for all its branches.
 *
 * Staff are excluded: ensureAdminAccessToGarage puts every RECEPTIONMATE_STAFF user on every
 * garage, so a staff-triggered path must not sweep the whole estate.
 */
export async function setOnboardingStageForUser(
  userId: string,
  stage: OnboardingStage,
  opts?: StageOpts,
): Promise<void> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, garageAccessIds: true },
    });
    if (!user || user.role === 'RECEPTIONMATE_STAFF') return;
    for (const garageId of user.garageAccessIds ?? []) {
      await setOnboardingStage(garageId, stage, opts);
    }
  } catch (err) {
    console.error(`[PIPELINE] setOnboardingStageForUser(${userId}, ${stage}) failed:`, err);
  }
}
