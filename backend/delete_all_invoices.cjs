const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function deleteAllInvoices() {
  console.log('Counting invoices...');
  const countBefore = await prisma.invoice.count();
  console.log(`Found ${countBefore} invoices\n`);

  if (countBefore > 0) {
    console.log('Deleting ALL invoices...');
    const result = await prisma.invoice.deleteMany({});
    console.log(`✓ Deleted ${result.count} invoices\n`);
  }

  // Verify deletion
  const countAfter = await prisma.invoice.count();
  console.log(`Remaining invoices: ${countAfter}`);

  if (countAfter === 0) {
    console.log('✓ All invoices successfully deleted');
  } else {
    console.log('⚠ Warning: Some invoices may remain');
  }

  await prisma.$disconnect();
}

deleteAllInvoices().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
