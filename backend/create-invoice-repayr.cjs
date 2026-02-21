const { PrismaClient } = require('../backend/node_modules/.prisma/client');
const prisma = new PrismaClient();

async function createInvoice() {
  // Find the "repayr my car" garage
  const garage = await prisma.garage.findFirst({
    where: {
      name: {
        contains: 'repayr',
        mode: 'insensitive',
      },
    },
  });

  if (!garage) {
    console.log('Garage not found');
    return;
  }

  console.log('Found garage:', garage.name, '(ID:', garage.id + ')');

  // Find the user with a mandate for this garage
  const user = await prisma.user.findFirst({
    where: {
      garageAccessIds: {
        has: garage.id,
      },
      gocardlessMandateId: {
        not: null,
      },
    },
    orderBy: {
      createdAt: 'asc',
    },
  });

  if (!user) {
    console.log('No user with mandate found for this garage');
    return;
  }

  console.log('Found user:', user.email, '(mandate:', user.gocardlessMandateId + ')');

  // Calculate invoice amounts (all in pence)
  const subscriptionAmount = 20000; // £200 in pence
  const vatRate = 0.20;
  const vatAmount = Math.round(subscriptionAmount * vatRate); // £40 in pence
  const total = subscriptionAmount + vatAmount; // £240 in pence

  // Set billing period (current month)
  const now = new Date();
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);

  console.log('\nCreating invoice:');
  console.log('Period:', periodStart.toISOString().split('T')[0], 'to', periodEnd.toISOString().split('T')[0]);
  console.log('Subscription: £200.00');
  console.log('VAT (20%): £40.00');
  console.log('Total: £240.00');

  const invoice = await prisma.invoice.create({
    data: {
      garageId: garage.id,
      businessId: garage.businessId,
      userId: user.id,
      periodStart,
      periodEnd,
      minutesUsed: 0,
      minutesIncluded: 0,
      smsCount: 0,
      subscriptionAmount: subscriptionAmount,
      minutesAmount: 0,
      smsAmount: 0,
      subtotal: subscriptionAmount,
      vatAmount: vatAmount,
      total: total,
      subscriptionCostGbp: 200,
      costPerMinuteGbp: 0,
      vatRate: vatRate,
      status: 'draft',
    },
  });

  console.log('\n✓ Invoice created successfully!');
  console.log('Invoice ID:', invoice.id);
  console.log('Status:', invoice.status);
  console.log('Total: £' + (invoice.total / 100).toFixed(2));
}

createInvoice()
  .then(() => process.exit(0))
  .catch(e => {
    console.error('Error:', e.message);
    process.exit(1);
  });
