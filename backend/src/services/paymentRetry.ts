// Automatic retry of failed Direct Debit collections.
//
// Until now a bounced payment was terminal: the invoice was marked 'failed' and nothing ever
// tried again. Caldwell bounced on 30 June and was still unpaid seven weeks later; Cairneys the
// same from 4 July. Both kept using the service throughout.
//
// BACS failures are usually transient — insufficient funds on the day, a bank glitch — so a
// retry a few days later collects most of them without anyone touching it. What it must never do
// is hammer a customer's account or retry something that cannot possibly succeed.
//
// Rules:
//  - Wait RETRY_AFTER_DAYS before the first retry (giving the customer time to fund the account).
//  - At most MAX_ATTEMPTS retries per invoice, then stop and leave it for a human.
//  - Never retry without a usable mandate — a cancelled mandate needs the customer to re-authorise,
//    and charging against it just produces another failure and another fee.
//  - Never retry an archived garage (a former customer).
//  - Idempotency keys are derived from invoice + attempt number, so a double run cannot
//    double-charge.

import https from 'https';
import { prisma } from '../db.js';

const GC_VERSION = '2015-07-06';
const RETRY_AFTER_DAYS = 4;
const MAX_ATTEMPTS = 2;
const USABLE_MANDATE = ['active', 'pending_submission', 'submitted', 'pending_customer_approval'];

function gc(method: string, path: string, body?: any, idempotencyKey?: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const token = process.env.GOCARDLESS_ACCESS_TOKEN;
    if (!token) return reject(new Error('GOCARDLESS_ACCESS_TOKEN not set'));
    const payload = body ? JSON.stringify(body) : null;
    const headers: Record<string, string | number> = {
      Authorization: `Bearer ${token}`, 'GoCardless-Version': GC_VERSION,
    };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
      if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    }
    const req = https.request({ hostname: 'api.gocardless.com', path, method, headers }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** How many times have we already tried to collect this invoice? Stored on the invoice notes-free
 *  by counting attempts in creditReason, which is otherwise unused for pending invoices. */
function attemptsFrom(reason: string | null): number {
  const m = (reason || '').match(/retry:(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

export async function retryFailedPayments(): Promise<{ retried: number; skipped: string[] }> {
  const cutoff = new Date(Date.now() - RETRY_AFTER_DAYS * 864e5);
  const failed = await prisma.invoice.findMany({
    where: { status: 'failed', updatedAt: { lte: cutoff } },
    orderBy: { periodStart: 'asc' },
  });

  const skipped: string[] = [];
  let retried = 0;

  for (const inv of failed) {
    const garage = await prisma.garage.findUnique({
      where: { id: inv.garageId },
      select: { name: true, archivedAt: true },
    });
    if (!garage) { skipped.push(`${inv.id}: garage missing`); continue; }
    if (garage.archivedAt) { skipped.push(`${garage.name}: archived`); continue; }

    const attempts = attemptsFrom(inv.creditReason);
    if (attempts >= MAX_ATTEMPTS) { skipped.push(`${garage.name}: ${attempts} attempts already, needs a human`); continue; }

    const user = await prisma.user.findFirst({
      where: { garageAccessIds: { has: inv.garageId } },
      select: { id: true, email: true, gocardlessMandateId: true },
    });
    if (!user?.gocardlessMandateId) { skipped.push(`${garage.name}: no mandate on file`); continue; }

    const m = await gc('GET', `/mandates/${user.gocardlessMandateId}`);
    const status = m?.mandates?.status;
    if (!USABLE_MANDATE.includes(status)) {
      // A dead mandate cannot be retried into life — the customer has to re-authorise.
      skipped.push(`${garage.name}: mandate ${status || 'unknown'} — needs re-authorising`);
      continue;
    }

    const r = await gc('POST', '/payments', {
      payments: {
        amount: inv.total, currency: 'GBP',
        description: `ReceptionMate ${inv.periodStart.toISOString().slice(0, 10)}`,
        links: { mandate: user.gocardlessMandateId },
      },
    }, `retry-${inv.id}-${attempts + 1}`);

    if (r.error) {
      console.error(`[PAYMENT_RETRY] ${garage.name}: ${JSON.stringify(r.error).slice(0, 200)}`);
      skipped.push(`${garage.name}: GoCardless rejected the retry`);
      continue;
    }

    await prisma.invoice.update({
      where: { id: inv.id },
      data: {
        status: 'pending',
        gocardlessPaymentId: r.payments.id,
        creditReason: `retry:${attempts + 1}`,
      },
    });
    retried++;
    console.log(`[PAYMENT_RETRY] ${garage.name} £${(inv.total / 100).toFixed(2)} — attempt ${attempts + 1}, payment ${r.payments.id} due ${r.payments.charge_date}`);
  }

  if (retried || skipped.length) {
    console.log(`[PAYMENT_RETRY] retried ${retried}, skipped ${skipped.length}`);
    for (const s of skipped) console.log(`[PAYMENT_RETRY]   skipped — ${s}`);
  }
  return { retried, skipped };
}
