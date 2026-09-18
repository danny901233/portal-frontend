// Collect a first-month subscription invoice that was left in draft by the GoCardless metadata
// bug (four metadata pairs; GC permits three). The charge failed, the catch swallowed it, and
// the invoice has sat uncollected ever since.
//
//   node scripts/charge-stuck-first-month.cjs <invoiceId>           # dry run
//   node scripts/charge-stuck-first-month.cjs <invoiceId> --apply   # takes REAL money
//
// Refuses to act unless the invoice is still 'draft' with no payment against it, so running it
// twice cannot double-charge.
require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env') });
const gocardless = require('gocardless-nodejs');
const constants = require('gocardless-nodejs/constants');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const APPLY = process.argv.includes('--apply');
const invoiceId = process.argv[2];
if (!invoiceId || invoiceId.startsWith('--')) { console.error('usage: <invoiceId> [--apply]'); process.exit(1); }

async function main() {
  const inv = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: {
      id: true, status: true, total: true, subtotal: true, vatAmount: true,
      subscriptionAmount: true, createdAt: true, gocardlessPaymentId: true,
      garageId: true, userId: true,
    },
  });
  if (!inv) throw new Error('invoice not found');
  const user = await prisma.user.findUnique({
    where: { id: inv.userId },
    select: { email: true, gocardlessMandateId: true },
  });
  const garage = await prisma.garage.findUnique({ where: { id: inv.garageId }, select: { name: true } });

  console.log(`invoice   ${inv.id}`);
  console.log(`garage    ${garage?.name}`);
  console.log(`customer  ${user?.email}`);
  console.log(`raised    ${inv.createdAt.toISOString().slice(0, 10)}`);
  console.log(`amount    GBP ${(inv.total / 100).toFixed(2)}  (net ${(inv.subtotal / 100).toFixed(2)} + VAT ${(inv.vatAmount / 100).toFixed(2)})`);
  console.log(`status    ${inv.status}`);
  console.log(`mandate   ${user?.gocardlessMandateId || '(none)'}`);

  if (inv.status !== 'draft' || inv.gocardlessPaymentId) {
    console.log('\nAlready actioned — nothing to do. Refusing to charge again.');
    return;
  }
  if (!user?.gocardlessMandateId) throw new Error('no mandate on the user');

  const env = process.env.GOCARDLESS_ENVIRONMENT || 'sandbox';
  const client = gocardless(
    process.env.GOCARDLESS_ACCESS_TOKEN,
    env === 'live' ? constants.Environments.Live : constants.Environments.Sandbox,
  );
  console.log(`\nGoCardless environment: ${env.toUpperCase()}`);

  const mandate = await client.mandates.find(user.gocardlessMandateId);
  console.log(`mandate status: ${mandate.status}`);
  if (!['active', 'pending_submission', 'submitted'].includes(mandate.status)) {
    throw new Error(`mandate is ${mandate.status} — not chargeable`);
  }

  if (!APPLY) {
    console.log(`\n[dry run] would charge GBP ${(inv.total / 100).toFixed(2)} against ${user.gocardlessMandateId}`);
    console.log('Re-run with --apply to take the money.');
    return;
  }

  // Exactly the shape the fixed confirm-mandate uses: THREE metadata pairs, no more.
  const payment = await client.payments.create({
    amount: inv.total,
    currency: 'GBP',
    description: 'ReceptionMate - First Month',
    metadata: {
      user_id: inv.userId,
      type: 'first_month_subscription',
      invoice_count: '1',
    },
    links: { mandate: user.gocardlessMandateId },
  });
  await prisma.invoice.update({
    where: { id: inv.id },
    data: { status: 'pending', gocardlessPaymentId: payment.id },
  });
  console.log(`\nCHARGED. payment ${payment.id}, charge date ${payment.charge_date}, status ${payment.status}`);
  console.log(`Invoice ${inv.id} -> pending.`);
}

main().catch((e) => { console.error('\nFAILED:', e?.errors ? JSON.stringify(e.errors) : e); process.exit(1); })
  .finally(() => prisma.$disconnect());
