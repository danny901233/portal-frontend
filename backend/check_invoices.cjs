const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkInvoices() {
  const invoices = await prisma.invoice.findMany({
    select: {
      id: true,
      subscriptionAmount: true,
      minutesAmount: true,
      smsAmount: true,
      subtotal: true,
      vatAmount: true,
      total: true,
      garage: {
        select: {
          name: true
        }
      }
    },
    orderBy: { createdAt: 'desc' },
    take: 5
  });

  console.log('Recent invoices:');
  invoices.forEach(inv => {
    console.log(`\nGarage: ${inv.garage.name}`);
    console.log(`  Subscription: £${(inv.subscriptionAmount / 100).toFixed(2)}`);
    console.log(`  Minutes: £${(inv.minutesAmount / 100).toFixed(2)}`);
    console.log(`  SMS: £${(inv.smsAmount / 100).toFixed(2)}`);
    console.log(`  Subtotal: £${(inv.subtotal / 100).toFixed(2)}`);
    console.log(`  VAT: £${(inv.vatAmount / 100).toFixed(2)}`);
    console.log(`  Total: £${(inv.total / 100).toFixed(2)}`);

    // Check calculation
    const expectedSubtotal = inv.subscriptionAmount + inv.minutesAmount + inv.smsAmount;
    const expectedVat = Math.round(expectedSubtotal * 0.20);
    const expectedTotal = expectedSubtotal + expectedVat;

    if (inv.subtotal !== expectedSubtotal || inv.total !== expectedTotal) {
      console.log(`  ❌ CALCULATION ERROR!`);
      console.log(`    Expected subtotal: £${(expectedSubtotal / 100).toFixed(2)}`);
      console.log(`    Expected total: £${(expectedTotal / 100).toFixed(2)}`);
    }
  });

  await prisma.$disconnect();
}

checkInvoices().catch(console.error);
