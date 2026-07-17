import { prisma } from '../db.js';
import {
  updateOpportunity,
  HL_AWAITING_CREDENTIALS_STAGE_ID,
  HL_AGENT_BUILT_STAGE_ID,
  HL_INVITED_STAGE_ID,
  LIVE_STAGE_ID,
} from '../services/highlevel.js';

// Single place that moves a garage along the sales-led onboarding pipeline and mirrors the move
// into HighLevel. Five call sites use it (agreement signed, marked signed externally, invited,
// mandate confirmed, booking-activation reached) and none of them should be duplicating the
// resolve-garage / guard / fire-and-forget dance.

export type OnboardingStage =
  | 'awaiting_agreement'
  | 'awaiting_credentials'
  | 'agent_built'
  | 'invited'
  | 'mandate_pending'
  | 'live';

// Portal stage -> HighLevel stage, using the stages the pipeline already had. Stages with no
// entry (awaiting_agreement, mandate_pending) deliberately don't move HL: "Contract Sent" is set
// by whoever sends the agreement, and mandate_pending is a portal-side waiting room that sales
// don't need to see — the deal is still "Invited" to them until it goes live.
const HL_STAGE_FOR: Partial<Record<OnboardingStage, string>> = {
  awaiting_credentials: HL_AWAITING_CREDENTIALS_STAGE_ID, // "Awaiting Integration Credentials"
  agent_built: HL_AGENT_BUILT_STAGE_ID,                   // "Agent Account Setup, awaiting go live date"
  invited: HL_INVITED_STAGE_ID,                           // "Invited — awaiting DD mandate"
  live: LIVE_STAGE_ID,                                    // "Live and £££££"
};

/**
 * Move one garage to `stage` and mirror it into HighLevel.
 *
 * Never throws and never blocks: every caller is on a customer's critical path (signing,
 * confirming a mandate), so a CRM hiccup must not surface as a failed request. The HL call is
 * fire-and-forget and updateOpportunity already logs-and-returns rather than throwing.
 *
 * Garages already at 'live' are left alone entirely — that's every pre-existing garage on the
 * estate (they were defaulted to 'live'), and they must not be dragged into the pipeline or have
 * their HL opportunity rewritten by, say, an unrelated mandate change.
 */
export async function setOnboardingStage(
  garageId: string,
  stage: OnboardingStage,
  opts?: { monetaryValueGbp?: number; reason?: string },
): Promise<void> {
  try {
    const garage = await prisma.garage.findUnique({
      where: { id: garageId },
      select: { id: true, name: true, onboardingStage: true, ghlOpportunityId: true, onboardingStageAt: true },
    });
    if (!garage) return;
    if (garage.onboardingStage === 'live') return; // already onboarded — not ours to touch
    if (garage.onboardingStage === stage) return; // no-op

    // Record WHEN this stage was entered. Merge rather than replace: the map is the garage's
    // whole history, and an earlier stage's time must survive later moves. Guarded above by the
    // same-stage early return, so this only ever writes a stage's FIRST entry.
    const stampedAt = {
      ...((garage.onboardingStageAt as Record<string, string> | null) ?? {}),
      [stage]: new Date().toISOString(),
    };
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
      ...(typeof opts?.monetaryValueGbp === 'number' ? { monetaryValueGbp: opts.monetaryValueGbp } : {}),
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
  opts?: { monetaryValueGbp?: number; reason?: string },
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
