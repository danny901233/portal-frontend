const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function countInvoices() {
  const count = await prisma.invoice.count();
  console.log(`Total invoices in database: ${count}`);

  if (count > 0) {
    const invoices = await prisma.invoice.findMany({
      select: {
        id: true,
        subscriptionAmount: true,
        minutesAmount: true,
        smsAmount: true,
        subtotal: true,
        vatAmount: true,
        total: true,
        createdAt: true,
        garage: {
          select: {
            name: true
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    console.log('\nAll invoices:');
    invoices.forEach((inv, idx) => {
      console.log(`\n${idx + 1}. Garage: ${inv.garage.name} (${inv.createdAt.toISOString()})`);
      console.log(`   ID: ${inv.id.slice(0, 8)}`);
      console.log(`   Subscription: £${(inv.subscriptionAmount / 100).toFixed(2)}`);
      console.log(`   Minutes: £${(inv.minutesAmount / 100).toFixed(2)}`);
      console.log(`   SMS: £${(inv.smsAmount / 100).toFixed(2)}`);
      console.log(`   Subtotal: £${(inv.subtotal / 100).toFixed(2)}`);
      console.log(`   VAT: £${(inv.vatAmount / 100).toFixed(2)}`);
      console.log(`   Total: £${(inv.total / 100).toFixed(2)}`);

      // Check calculation
      const expectedSubtotal = inv.subscriptionAmount + inv.minutesAmount + inv.smsAmount;
      const expectedVat = Math.round(expectedSubtotal * 0.20);
      const expectedTotal = expectedSubtotal + expectedVat;

      if (inv.subtotal !== expectedSubtotal || inv.total !== expectedTotal) {
        console.log(`   ❌ CALCULATION ERROR!`);
        console.log(`      Expected subtotal: £${(expectedSubtotal / 100).toFixed(2)}`);
        console.log(`      Expected total: £${(expectedTotal / 100).toFixed(2)}`);
      } else {
        console.log(`   ✓ Calculations correct`);
      }
    });
  }

  await prisma.$disconnect();
}

countInvoices().catch(console.error);
