import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function deleteTestData() {
  try {
    console.log('🔍 Searching for test data...\n');

    // Find garages with test in name, MPB 4x4, or specific ID
    const garagesToDelete = await prisma.garage.findMany({
      where: {
        OR: [
          { name: { contains: 'test', mode: 'insensitive' } },
          { name: 'MPB 4x4' },
          { id: 'e0a9c4b7-c912-4f0d-9791-c70986037690' },
        ],
      },
      include: {
        calls: true,
        conversations: true,
        customers: true,
      },
    });

    console.log('📋 Found garages to delete:');
    garagesToDelete.forEach((garage) => {
      console.log(`  - ${garage.name} (ID: ${garage.id})`);
      console.log(`    Calls: ${garage.calls.length}, Conversations: ${garage.conversations.length}, Customers: ${garage.customers.length}`);
    });

    console.log(`\n📊 Total: ${garagesToDelete.length} garages\n`);

    // Confirm deletion
    console.log('⚠️  WARNING: This will permanently delete these records and all related data!');
    console.log('Press Ctrl+C to cancel, or wait 5 seconds to proceed...\n');
    
    await new Promise(resolve => setTimeout(resolve, 5000));

    console.log('🗑️  Starting deletion process...\n');

    // Delete garages (cascade will handle most related data)
    for (const garage of garagesToDelete) {
      console.log(`Deleting garage: ${garage.name} (${garage.id})...`);
      
      try {
        // Delete related data that might not cascade
        await prisma.invoice.deleteMany({ where: { garageId: garage.id } });
        await prisma.agentConfiguration.deleteMany({ where: { garageId: garage.id } });
        await prisma.agentKnowledgeDocument.deleteMany({ where: { garageId: garage.id } });
        await prisma.socialMediaConnection.deleteMany({ where: { garageId: garage.id } });
        await prisma.smsBookingLink.deleteMany({ where: { garageId: garage.id } });
        
        // Delete the garage (this will cascade delete calls, conversations, customers)
        await prisma.garage.delete({ where: { id: garage.id } });
        console.log(`  ✅ Deleted garage: ${garage.name}`);
      } catch (error: any) {
        console.error(`  ❌ Error deleting garage ${garage.name}:`, error.message);
      }
    }

    console.log('\n✅ Deletion complete!');
    console.log(`   Deleted ${garagesToDelete.length} garages and their associated data`);

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

deleteTestData();
