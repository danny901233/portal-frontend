import { prisma } from '../db.js';

/**
 * Resolve the user who should carry a garage's billing cycle dates.
 *
 * THE ONLY correct answer is the mandate holder. findUsersDueForBilling selects on:
 *     nextBillingDate <= lookAhead AND gocardlessMandateId != null AND mustSetupPayment = false
 * so dates written to a user WITHOUT a mandate are dead on arrival — that user is never selected
 * and the customer is silently never invoiced.
 *
 * What this replaces: `user.findFirst({ where: { garageAccessIds: { has: garageId } } })` with no
 * role filter, no mandate filter and no ordering. Two problems with that:
 *   1. ensureAdminAccessToGarage adds every RECEPTIONMATE_STAFF user to each new garage, before
 *      the customer's own user exists — so the staff row is older and a likely winner.
 *   2. Even among real customers it's a coin flip. Verified on live data: it picks a different
 *      user from the mandate holder on 8 of 46 garages.
 *
 * Do NOT be tempted by "prefer the branch MANAGER who owns only this garage" — that reads well
 * but is wrong: measured against live data it disagrees with the mandate holder on 4 of 7
 * multi-user garages (the mandate is often held by a group/accounts login that manages several
 * branches and isn't the branch manager). Mirrors the CHARGING path, which already gets this
 * right by requiring gocardlessMandateId.
 */
export async function resolveBillingUser(garageId: string) {
  const holders = await prisma.user.findMany({
    where: {
      garageAccessIds: { has: garageId },
      gocardlessMandateId: { not: null }, // the whole point — anyone else can't be billed
      role: { not: 'RECEPTIONMATE_STAFF' }, // belt and braces; staff never have a mandate anyway
    },
    orderBy: { createdAt: 'asc' }, // deterministic rather than "whatever Postgres returns first"
    select: {
      id: true,
      email: true,
      garageAccessIds: true,
      billingCycleStartDate: true,
      nextBillingDate: true,
    },
  });

  if (!holders.length) {
    // No mandate = nothing to start. Worth shouting about: a garage reaching its activation
    // threshold (or its trial end) with no payment method is a commercial problem, not a
    // no-op — previously this wrote dates to whoever turned up and looked like it worked.
    console.warn(`[BILLING] garage ${garageId} has no mandate holder — cannot start a billing cycle`);
    return null;
  }

  // Multiple mandates on one garage is unusual; prefer whoever owns only this garage (the branch's
  // own payer) over a group login, then oldest. Same tiebreak as the charging path.
  return holders.find((u) => u.garageAccessIds.length === 1) ?? holders[0];
}
