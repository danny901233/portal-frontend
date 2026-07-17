// Phase A dual-write: the GoCardless mandate + billing-cycle dates are migrating from
// the User to the Business (the paying entity). Until Phase B flips reads to the business,
// every user-side write is mirrored here so the business copy stays current. Non-fatal by
// design — a mirror failure must never break the primary user/payment flow.
import { prisma } from '../db.js';

export async function syncBusinessBillingFromUser(userId: string): Promise<void> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        role: true,
        gocardlessMandateId: true,
        gocardlessCustomerId: true,
        billingCycleStartDate: true,
        nextBillingDate: true,
        garageAccessIds: true,
      },
    });
    if (!user || user.role === 'RECEPTIONMATE_STAFF') return;
    const gids = user.garageAccessIds || [];
    if (!gids.length) return;
    const garages = await prisma.garage.findMany({ where: { id: { in: gids } }, select: { businessId: true } });
    const businessIds = [...new Set(garages.map((g) => g.businessId).filter((b): b is string => !!b))];
    for (const businessId of businessIds) {
      await prisma.business.update({
        where: { id: businessId },
        data: {
          gocardlessMandateId: user.gocardlessMandateId,
          gocardlessCustomerId: user.gocardlessCustomerId,
          billingCycleStartDate: user.billingCycleStartDate,
          nextBillingDate: user.nextBillingDate,
        },
      });
    }
  } catch (err) {
    console.error('[billingSync] mirror mandate/cycle to business failed:', err);
  }
}

// Phase B read-flip: the mandate a payment is charged against is sourced from the BUSINESS
// (the paying entity), falling back to the user's mandate if a business somehow has none.
// Verified identical to the old per-user selection for every garage (0 mismatches), so this
// changes no charge today; it makes the business the source of truth going forward.
export async function resolveChargeMandate(
  businessId: string | null | undefined,
  userMandateId: string | null | undefined,
): Promise<string | null | undefined> {
  if (businessId) {
    const biz = await prisma.business.findUnique({
      where: { id: businessId },
      select: { gocardlessMandateId: true },
    });
    if (biz?.gocardlessMandateId) return biz.gocardlessMandateId;
  }
  return userMandateId;
}
