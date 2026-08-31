import https from 'https';
import { prisma } from '../db.js';
import { markBusinessNeedsMandate } from '../utils/businessBilling.js';
import { startArrearsForFailedInvoice, clearArrearsForGarage } from './paymentArrears.js';

const GC_HOST = 'api.gocardless.com';
const GC_VERSION = '2015-07-06';

function gcGet(path: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const token = process.env.GOCARDLESS_ACCESS_TOKEN;
    if (!token) return reject(new Error('GOCARDLESS_ACCESS_TOKEN not set'));

    const opts = {
      hostname: GC_HOST,
      path,
      headers: {
        Authorization: `Bearer ${token}`,
        'GoCardless-Version': GC_VERSION,
      },
    };

    https.get(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

/**
 * Syncs all non-paid invoices with GoCardless to update their statuses.
 * Runs daily to catch any missed webhooks.
 */
export async function syncGocardlessPayments(): Promise<void> {
  console.log('[GC Sync] Starting daily GoCardless payment sync...');

  // Fetch all invoices that aren't in a final state and have a GoCardless payment ID
  const invoices = await prisma.invoice.findMany({
    where: {
      gocardlessPaymentId: { not: null },
      status: { in: ['pending', 'processing'] },
    },
    include: { garage: { select: { name: true } } },
  });

  if (invoices.length === 0) {
    console.log('[GC Sync] No pending invoices to sync.');
    return;
  }

  console.log(`[GC Sync] Checking ${invoices.length} pending invoice(s)...`);

  let updated = 0;
  let errors = 0;

  for (const invoice of invoices) {
    try {
      const response = await gcGet(`/payments/${invoice.gocardlessPaymentId}`);
      const payment = response.payments;

      if (!payment) {
        console.warn(`[GC Sync] No payment data for ${invoice.gocardlessPaymentId}`);
        continue;
      }

      // Map GoCardless status to our invoice status
      let newStatus: string | null = null;
      let paidAt: Date | null = null;

      switch (payment.status) {
        case 'paid_out':
        case 'confirmed':
          newStatus = 'paid';
          paidAt = payment.charge_date ? new Date(payment.charge_date) : new Date();
          break;
        case 'failed':
        case 'charged_back':
        case 'late_failure_settled':
          newStatus = 'failed';
          break;
        case 'cancelled':
          newStatus = 'cancelled';
          break;
        default:
          // still pending/processing on GC side — no change
          break;
      }

      if (newStatus && newStatus !== invoice.status) {
        await prisma.invoice.update({
          where: { id: invoice.id },
          data: {
            status: newStatus,
            ...(paidAt ? { paidAt } : {}),
          },
        });
        console.log(`[GC Sync] ✓ ${invoice.garage.name} invoice ${invoice.id}: ${invoice.status} → ${newStatus} (GC: ${payment.status})`);
        updated++;

        // Marking the invoice was never enough on its own — the arrears clock lives on the
        // garage. The webhook did this and has never once been delivered, so a bounced Direct
        // Debit only ever showed up as a 'failed' invoice nobody was watching.
        if (newStatus === 'failed') {
          await startArrearsForFailedInvoice(invoice, 'GC Sync');
        } else if (newStatus === 'paid') {
          await clearArrearsForGarage(invoice.garageId, 'GC Sync');
        }
      }
    } catch (err: any) {
      console.error(`[GC Sync] Error checking payment ${invoice.gocardlessPaymentId}:`, err.message);
      errors++;
    }
  }

  console.log(`[GC Sync] Done. Updated: ${updated}, Errors: ${errors}, Unchanged: ${invoices.length - updated - errors}`);
}


/**
 * Reconcile mandate status against GoCardless.
 *
 * The webhook is the intended route for this, but a mandate can be cancelled at the customer's
 * bank branch and the notification is easy to lose — an endpoint that isn't registered, a
 * delivery that failed, a webhook secret rotated. That silence is expensive: the subscription
 * simply stops being collectable while the garage carries on getting a full service. This poll
 * is the backstop, so the worst case is a day's delay rather than indefinite.
 *
 * Reads the mandate rather than trusting our copy, and only ever writes when the two disagree.
 */
export async function syncGocardlessMandates(): Promise<void> {
  const payers = await prisma.user.findMany({
    where: { gocardlessMandateId: { not: null } },
    select: { id: true, email: true, gocardlessMandateId: true, garageAccessIds: true },
  });

  if (payers.length === 0) {
    console.log('[GC Mandates] No mandates to check.');
    return;
  }

  console.log(`[GC Mandates] Checking ${payers.length} mandate(s)...`);
  const HEALTHY = new Set(['active', 'pending_customer_approval', 'pending_submission', 'submitted']);
  let dead = 0;

  for (const payer of payers) {
    try {
      const status = (await gcGet(`/mandates/${payer.gocardlessMandateId}`))?.mandates?.status;
      if (!status || HEALTHY.has(status)) continue;

      // cancelled / failed / expired — the same treatment the webhook would have applied.
      dead++;
      console.warn(`[GC Mandates] ⚠️ ${payer.email} mandate ${payer.gocardlessMandateId} is ${status}`);

      await prisma.user.update({
        where: { id: payer.id },
        data: { mustSetupPayment: true, gocardlessMandateId: null, gocardlessCustomerId: null },
      });
      await markBusinessNeedsMandate(payer.garageAccessIds as string[] | null, `mandate ${status}`);

      if (payer.garageAccessIds?.length) {
        const res = await prisma.garage.updateMany({
          where: { id: { in: payer.garageAccessIds }, archivedAt: null, paymentFailedAt: null },
          data: { paymentFailedAt: new Date() },
        });
        if (res.count > 0) {
          console.warn(`[GC Mandates] ⚠️ ${res.count} garage(s) now in arrears — mandate ${status}`);
        }
      }
    } catch (e) {
      // One unreadable mandate must not stop the rest being checked.
      console.error(`[GC Mandates] Failed to check ${payer.gocardlessMandateId}:`, e);
    }
  }

  console.log(`[GC Mandates] Done. ${dead} mandate(s) no longer collectable.`);
}
