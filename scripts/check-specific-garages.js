const { PrismaClient } = require('../backend/node_modules/.prisma/client');

const prisma = new PrismaClient();

async function checkSpecificGarages() {
  try {
    // Check for the specific ID
    const specificGarage = await prisma.garage.findUnique({
      where: { id: 'e0a9c4b7-c912-4f0d-9791-c70986037690' },
      include: {
        calls: true,
        conversations: true,
        customers: true,
      }
    });

    // Check for MPB 4x4
    const mpbGarage = await prisma.garage.findFirst({
      where: { name: 'MPB 4x4' },
      include: {
        calls: true,
        conversations: true,
        customers: true,
      }
    });

    console.log('\n🔍 Checking for specific garages:\n');
    
    if (specificGarage) {
      console.log(`Found garage with ID e0a9c4b7-c912-4f0d-9791-c70986037690:`);
      console.log(`  - ${specificGarage.name} (ID: ${specificGarage.id})`);
      console.log(`    Calls: ${specificGarage.calls.length}, Conversations: ${specificGarage.conversations.length}, Customers: ${specificGarage.customers.length}`);
    } else {
      console.log('✅ No garage found with ID e0a9c4b7-c912-4f0d-9791-c70986037690');
    }

    if (mpbGarage) {
      console.log(`\nFound garage MPB 4x4:`);
      console.log(`  - ${mpbGarage.name} (ID: ${mpbGarage.id})`);
      console.log(`    Calls: ${mpbGarage.calls.length}, Conversations: ${mpbGarage.conversations.length}, Customers: ${mpbGarage.customers.length}`);
    } else {
      console.log('✅ No garage found with name "MPB 4x4"');
    }

    // Check for any remaining test garages
    const remainingTestGarages = await prisma.garage.findMany({
      where: {
        name: { contains: 'test', mode: 'insensitive' }
      }
    });

    if (remainingTestGarages.length > 0) {
      console.log(`\n⚠️  Found ${remainingTestGarages.length} remaining test garages:`);
      remainingTestGarages.forEach(g => console.log(`  - ${g.name} (${g.id})`));
    } else {
      console.log('\n✅ No remaining test garages found');
    }

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

checkSpecificGarages();
