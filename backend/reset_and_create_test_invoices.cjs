const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function resetAndCreateTestInvoices() {
  console.log('Deleting all existing invoices...\n');

  // Delete all invoices
  const deleteResult = await prisma.invoice.deleteMany({});
  console.log(`✓ Deleted ${deleteResult.count} invoices\n`);

  // Find ReceptionMate branch
  const receptionmateBranch = await prisma.garage.findFirst({
    where: {
      name: {
        contains: 'receptionmate',
        mode: 'insensitive'
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
    }
  });

  if (!receptionmateBranch) {
    console.log('ReceptionMate branch not found. Searching all branches:');
    const allGarages = await prisma.garage.findMany({
      select: { id: true, name: true },
      take: 10
    });
    allGarages.forEach(g => console.log(`  - ${g.name}`));
    await prisma.$disconnect();
    return;
  }

  console.log(`Found: ${receptionmateBranch.name}`);
  console.log(`Creating 3 test invoices...\n`);

  // Create 3 invoices for different months
  const testData = [
    {
      month: 'January 2026',
      periodStart: new Date('2026-01-01'),
      periodEnd: new Date('2026-01-31'),
      minutesUsed: 450,
      smsCount: 28,
    },
    {
      month: 'December 2025',
      periodStart: new Date('2025-12-01'),
      periodEnd: new Date('2025-12-31'),
      minutesUsed: 380,
      smsCount: 15,
    },
    {
      month: 'November 2025',
      periodStart: new Date('2025-11-01'),
      periodEnd: new Date('2025-11-30'),
      minutesUsed: 520,
      smsCount: 22,
    }
  ];

  for (const test of testData) {
    // Calculate amounts in pence
    const subscriptionAmt = Math.round(receptionmateBranch.subscriptionCostGbp * 100);
    const overageMinutes = Math.max(0, test.minutesUsed - receptionmateBranch.includedMinutes);
    const minutesAmt = Math.round(overageMinutes * receptionmateBranch.costPerMinuteGbp * 100);
    const smsAmt = test.smsCount * 99; // £0.99 per SMS in pence

    // Calculate totals
    const subtotal = subscriptionAmt + minutesAmt + smsAmt;
    const vatAmt = Math.round(subtotal * receptionmateBranch.vatRate);
    const total = subtotal + vatAmt;

    console.log(`Invoice for ${test.month}:`);
    console.log(`  Period: ${test.periodStart.toISOString().split('T')[0]} to ${test.periodEnd.toISOString().split('T')[0]}`);
    console.log(`  Subscription: £${(subscriptionAmt / 100).toFixed(2)}`);
    console.log(`  Minutes: ${test.minutesUsed} used, ${receptionmateBranch.includedMinutes} included, ${overageMinutes} overage = £${(minutesAmt / 100).toFixed(2)}`);
    console.log(`  SMS: ${test.smsCount} @ £0.99 = £${(smsAmt / 100).toFixed(2)}`);
    console.log(`  Subtotal: £${(subtotal / 100).toFixed(2)}`);
    console.log(`  VAT (${(receptionmateBranch.vatRate * 100).toFixed(0)}%): £${(vatAmt / 100).toFixed(2)}`);
    console.log(`  Total: £${(total / 100).toFixed(2)}\n`);

    await prisma.invoice.create({
      data: {
        garageId: receptionmateBranch.id,
        businessId: receptionmateBranch.businessId,
        periodStart: test.periodStart,
        periodEnd: test.periodEnd,
        minutesUsed: test.minutesUsed,
        minutesIncluded: receptionmateBranch.includedMinutes,
        smsCount: test.smsCount,
        subscriptionAmount: subscriptionAmt,
        minutesAmount: minutesAmt,
        smsAmount: smsAmt,
        subtotal,
        vatAmount: vatAmt,
        total,
        subscriptionCostGbp: receptionmateBranch.subscriptionCostGbp,
        costPerMinuteGbp: receptionmateBranch.costPerMinuteGbp,
        vatRate: receptionmateBranch.vatRate,
        status: 'paid',
      },
    });
  }

  console.log(`✓ Created 3 test invoices for ${receptionmateBranch.name}`);
  await prisma.$disconnect();
}

resetAndCreateTestInvoices().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
