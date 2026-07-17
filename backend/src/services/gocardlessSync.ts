import https from 'https';
import { prisma } from '../db.js';

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
      }
    } catch (err: any) {
      console.error(`[GC Sync] Error checking payment ${invoice.gocardlessPaymentId}:`, err.message);
      errors++;
    }
  }

  console.log(`[GC Sync] Done. Updated: ${updated}, Errors: ${errors}, Unchanged: ${invoices.length - updated - errors}`);
}
