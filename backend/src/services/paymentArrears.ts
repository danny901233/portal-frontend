import { prisma } from '../db.js';
import { sendPaymentFailedEmail } from '../utils/email.js';
import { createPaymentSetupLink } from './directDebitRequestEmail.js';

/**
 * What happens when a Direct Debit payment fails or recovers.
 *
 * Extracted from the GoCardless webhook so the daily sync can apply exactly the same
 * treatment. That matters more than it sounds: no GoCardless webhook has ever been delivered
 * to this box, so until now the *only* code that started the arrears clock on a bounced
 * payment was code that has never once run. The poll is the path that actually fires.
 */

/**
 * Start the arrears clock for the garage an invoice belongs to, and tell the customer.
 *
 * Only stamps if not already set, so a second failure does not restart the grace period and
 * hand a non-paying account another two days.
 */
export async function startArrearsForFailedInvoice(
  invoice: { id: string; garageId: string },
  source: string,
): Promise<void> {
  const garage = await prisma.garage.findUnique({
    where: { id: invoice.garageId },
    select: { paymentFailedAt: true, name: true },
  });
  if (!garage) return;

  if (garage.paymentFailedAt) {
    console.warn(`[${source}] ⚠️ ${garage.name} payment failed — already in arrears since ${garage.paymentFailedAt.toISOString().slice(0, 10)}`);
    return;
  }

  await prisma.garage.update({
    where: { id: invoice.garageId },
    data: { paymentFailedAt: new Date() },
  });
  console.warn(`[${source}] ⚠️ ${garage.name} payment failed — arrears clock started`);

  // Tell them. A bounced Direct Debit used to be silent on the customer's side.
  try {
    const cfg = await prisma.agentConfiguration.findUnique({
      where: { garageId: invoice.garageId },
      select: { notificationEmails: true, branchName: true },
    });
    const to = cfg?.notificationEmails?.length ? cfg.notificationEmails : [];
    if (!to.length) return;

    // Direct Debit is a business-level mandate — one business, one mandate, however many portal
    // users it has. Asking the first user we happen to find gave an answer that depended on row
    // order, and told businesses paying perfectly well through a business-level mandate that their
    // Direct Debit had failed, because some colleague's half-finished invite had none of its own.
    const garageRow = await prisma.garage.findUnique({
      where: { id: invoice.garageId },
      select: { businessId: true },
    });
    const business = garageRow?.businessId
      ? await prisma.business.findUnique({
          where: { id: garageRow.businessId },
          select: { gocardlessMandateId: true },
        })
      : null;

    // Whoever the link is addressed to has to be able to act on it, so prefer the user already
    // flagged as needing to set payment up over whoever happens to come back first.
    const user =
      (await prisma.user.findFirst({
        where: { garageAccessIds: { has: invoice.garageId }, mustSetupPayment: true },
        select: { email: true },
      })) ||
      (await prisma.user.findFirst({
        where: { garageAccessIds: { has: invoice.garageId } },
        select: { email: true },
      }));

    // If the mandate is gone we cannot retry, so the email has to ask them to re-authorise.
    const mandateDead = !business?.gocardlessMandateId;
    let ddSetupUrl: string | undefined;
    if (mandateDead && user?.email) {
      try { ddSetupUrl = await createPaymentSetupLink(user.email); } catch { /* no portal user */ }
    }
    await sendPaymentFailedEmail(to, {
      branchName: cfg?.branchName || garage.name,
      retryDays: 4,
      mandateDead,
      ddSetupUrl,
    });
    console.log(`[${source}] payment-failed email sent to ${to.join(', ')}`);
  } catch (e: any) {
    console.error(`[${source}] could not send payment-failed email:`, e?.message);
  }
}

/** Payment received — clear the clock and restore access and full call details. */
export async function clearArrearsForGarage(garageId: string, source: string): Promise<void> {
  const garage = await prisma.garage.findUnique({
    where: { id: garageId },
    select: { paymentFailedAt: true, accessRestricted: true },
  });
  if (!garage?.paymentFailedAt && !garage?.accessRestricted) return;

  await prisma.garage.update({
    where: { id: garageId },
    data: { paymentFailedAt: null, accessRestricted: false },
  });
  console.log(`[${source}] Garage ${garageId} out of arrears — payment received`);
}
