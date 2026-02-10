const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function createTestInvoices() {
  console.log('Creating test invoices...\n');

  // Get all garages
  const garages = await prisma.garage.findMany({
    where: {
      subscriptionCostGbp: {
        gt: 0
      }
    },
    select: {
      id: true,
      name: true,
      businessId: true,
      subscriptionCostGbp: true,
      includedMinutes: true,
      costPerMinuteGbp: true,
      vatRate: true,
    },
    take: 5 // Create test invoices for first 5 garages
  });

  if (garages.length === 0) {
    console.log('No garages found with subscription cost set.');
    await prisma.$disconnect();
    return;
  }

  const periodStart = new Date('2026-01-01');
  const periodEnd = new Date('2026-01-31');

  for (const garage of garages) {
    // Generate random test usage data
    const minutesUsed = Math.floor(Math.random() * 200) + 50; // 50-250 minutes
    const smsCount = Math.floor(Math.random() * 30); // 0-29 SMS

    // Calculate amounts in pence
    const subscriptionAmt = Math.round(garage.subscriptionCostGbp * 100);
    const overageMinutes = Math.max(0, minutesUsed - garage.includedMinutes);
    const minutesAmt = Math.round(overageMinutes * garage.costPerMinuteGbp * 100);
    const smsAmt = smsCount * 99; // £0.99 per SMS in pence

    // Calculate totals - THIS IS THE KEY FIX
    const subtotal = subscriptionAmt + minutesAmt + smsAmt;
    const vatAmt = Math.round(subtotal * garage.vatRate);
    const total = subtotal + vatAmt;

    console.log(`Creating invoice for ${garage.name}:`);
    console.log(`  Subscription: £${(subscriptionAmt / 100).toFixed(2)}`);
    console.log(`  Minutes: ${minutesUsed} used, ${garage.includedMinutes} included, ${overageMinutes} overage = £${(minutesAmt / 100).toFixed(2)}`);
    console.log(`  SMS: ${smsCount} @ £0.99 = £${(smsAmt / 100).toFixed(2)}`);
    console.log(`  Subtotal: £${(subtotal / 100).toFixed(2)}`);
    console.log(`  VAT (${(garage.vatRate * 100).toFixed(0)}%): £${(vatAmt / 100).toFixed(2)}`);
    console.log(`  Total: £${(total / 100).toFixed(2)}\n`);

    await prisma.invoice.create({
      data: {
        garageId: garage.id,
        businessId: garage.businessId,
        periodStart,
        periodEnd,
        minutesUsed,
        minutesIncluded: garage.includedMinutes,
        smsCount,
        subscriptionAmount: subscriptionAmt,
        minutesAmount: minutesAmt,
        smsAmount: smsAmt,
        subtotal,
        vatAmount: vatAmt,
        total,
        subscriptionCostGbp: garage.subscriptionCostGbp,
        costPerMinuteGbp: garage.costPerMinuteGbp,
        vatRate: garage.vatRate,
        status: 'draft',
      },
    });
  }

  console.log(`\n✓ Created ${garages.length} test invoices`);
  await prisma.$disconnect();
}

createTestInvoices().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
