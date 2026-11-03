import { prisma } from '../db.js';

/**
 * Direct Debit state lives on the Business: a mandate authorises collection for the company,
 * not for the individual who happened to click through onboarding. Holding it on User meant a
 * cancelled mandate only ever prompted the original signatory, and colleagues just found the
 * portal blank with nothing telling them why.
 *
 * User.gocardlessMandateId is still the source of truth for billing itself, which runs daily
 * and is moved separately. Everything here keeps the Business copy in step so that move is a
 * one-line change rather than a leap of faith.
 */

/** The business behind a user, via any live garage they can see. Null for staff and test rigs. */
export async function businessIdForUser(garageAccessIds: string[] | null | undefined): Promise<string | null> {
  if (!garageAccessIds?.length) return null;
  const garage = await prisma.garage.findFirst({
    where: { id: { in: garageAccessIds }, archivedAt: null, businessId: { not: null } },
    select: { businessId: true },
  });
  return garage?.businessId ?? null;
}

/**
 * Record an authorised mandate against the business and clear the prompt.
 * Never throws: a mandate that GoCardless has accepted must not be lost because our
 * bookkeeping failed, and User already holds the copy billing reads.
 */
export async function setBusinessMandate(
  garageAccessIds: string[] | null | undefined,
  mandateId: string,
  customerId: string | null,
): Promise<void> {
  try {
    const businessId = await businessIdForUser(garageAccessIds);
    if (!businessId) return;
    await prisma.business.update({
      where: { id: businessId },
      data: { gocardlessMandateId: mandateId, gocardlessCustomerId: customerId, mustSetupPayment: false },
    });
  } catch (e) {
    console.error('[Billing] Failed to record mandate on business:', e);
  }
}

/**
 * The business can no longer be collected from — mandate cancelled, failed or expired.
 * Clears the dead id so nothing can bill against it, and raises the prompt for EVERY user of
 * the business rather than just the one who originally signed.
 */
export async function markBusinessNeedsMandate(
  garageAccessIds: string[] | null | undefined,
  reason: string,
): Promise<void> {
  try {
    const businessId = await businessIdForUser(garageAccessIds);
    if (!businessId) return;
    await prisma.business.update({
      where: { id: businessId },
      data: { gocardlessMandateId: null, gocardlessCustomerId: null, mustSetupPayment: true },
    });
    console.warn(`[Billing] Business ${businessId} needs a new mandate — ${reason}`);
  } catch (e) {
    console.error('[Billing] Failed to flag business for mandate setup:', e);
  }
}

/**
 * Does this user's business still need a Direct Debit authorised?
 *
 * Both conditions must hold: the business is flagged AND has no mandate on file. The flag
 * alone is not enough — a business that has since authorised one would otherwise be asked for
 * a second, and billing charges every mandate it finds.
 */
export async function businessNeedsPaymentSetup(
  garageAccessIds: string[] | null | undefined,
): Promise<boolean> {
  try {
    const businessId = await businessIdForUser(garageAccessIds);
    if (!businessId) return false;
    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: { mustSetupPayment: true, gocardlessMandateId: true },
    });
    return Boolean(business?.mustSetupPayment) && !business?.gocardlessMandateId;
  } catch (e) {
    // Never block a login on this check failing.
    console.error('[Billing] business payment-setup check failed:', e);
    return false;
  }
}

/**
 * Is this garage's business billed by card? Card customers never get the Direct Debit reminder,
 * whatever the payment-setup flag says, because there is no mandate for them to set up.
 */
export async function garageIsCardBilled(garageId: string): Promise<boolean> {
  try {
    const garage = await prisma.garage.findUnique({
      where: { id: garageId },
      select: { business: { select: { billingMethod: true } } },
    });
    return garage?.business?.billingMethod === 'stripe_card';
  } catch (e) {
    console.error('[Billing] card-billing check failed:', e);
    return false;
  }
}

/**
 * A card has been saved for a card-billed garage: there is no mandate to set up, so clear the
 * payment-setup prompt for the business and every user on the garage. Does nothing for a
 * Direct Debit garage — those are cleared only by a confirmed mandate.
 */
export async function clearCardSetupFlags(garageId: string): Promise<void> {
  const garage = await prisma.garage.findUnique({
    where: { id: garageId },
    select: { businessId: true, business: { select: { billingMethod: true } } },
  });
  if (garage?.business?.billingMethod !== 'stripe_card' || !garage.businessId) return;
  await prisma.business.update({ where: { id: garage.businessId }, data: { mustSetupPayment: false } });
  await prisma.user.updateMany({
    where: { garageAccessIds: { has: garageId }, mustSetupPayment: true },
    data: { mustSetupPayment: false },
  });
}
