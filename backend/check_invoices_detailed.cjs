const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkInvoicesDetailed() {
  console.log('DATABASE_URL:', process.env.DATABASE_URL?.substring(0, 30) + '...\n');

  // Count all invoices
  const totalInvoices = await prisma.invoice.count();
  console.log(`Total invoices in database: ${totalInvoices}\n`);

  if (totalInvoices > 0) {
    // Get all invoices with garage details
    const invoices = await prisma.invoice.findMany({
      include: {
        garage: {
          select: {
            name: true,
            businessId: true,
          }
        },
        business: {
          select: {
            name: true,
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    console.log('All invoices found:');
    invoices.forEach((inv, idx) => {
      console.log(`\n${idx + 1}. Invoice ID: ${inv.id.slice(0, 8)}`);
      console.log(`   Garage: ${inv.garage?.name || 'Unknown'}`);
      console.log(`   Business: ${inv.business?.name || 'None'}`);
      console.log(`   Period: ${inv.periodStart.toISOString().split('T')[0]} to ${inv.periodEnd.toISOString().split('T')[0]}`);
      console.log(`   Total: £${(inv.total / 100).toFixed(2)}`);
      console.log(`   Status: ${inv.status}`);
    });
  } else {
    console.log('No invoices found in database.');

    // Check for garages mentioned
    console.log('\nSearching for mentioned garages:');
    const innout = await prisma.garage.findMany({
      where: {
        name: {
          contains: 'in n out',
          mode: 'insensitive'
        }
      },
      select: { id: true, name: true }
    });

    const eldon = await prisma.garage.findMany({
      where: {
        name: {
          contains: 'eldon',
          mode: 'insensitive'
        }
      },
      select: { id: true, name: true }
    });

    if (innout.length > 0) {
      console.log('\nFound "In N Out" garages:');
      innout.forEach(g => console.log(`  - ${g.name} (${g.id})`));
    }

    if (eldon.length > 0) {
      console.log('\nFound "Eldon" garages:');
      eldon.forEach(g => console.log(`  - ${g.name} (${g.id})`));
    }
  }

  await prisma.$disconnect();
}

checkInvoicesDetailed().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
