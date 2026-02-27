import { PrismaClient } from '../backend/node_modules/.prisma/client/index.js';

const prisma = new PrismaClient();

async function deleteGarageCalls() {
  try {
    const searchTerm = process.argv[2];
    
    if (!searchTerm) {
      console.log('Usage: npx tsx scripts/delete-garage-calls.ts "GARAGE_NAME"');
      console.log('Example: npx tsx scripts/delete-garage-calls.ts "EAC TELFORD HALESFIELD"');
      await prisma.$disconnect();
      return;
    }

    console.log(`🔍 Searching for garages matching: "${searchTerm}"\n`);

    // Search in garage name and branch name
    const garages = await prisma.garage.findMany({
      where: {
        name: {
          contains: searchTerm,
          mode: 'insensitive'
        }
      },
      include: {
        _count: {
          select: {
            calls: true
          }
        }
      }
    });

    if (garages.length === 0) {
      console.log(`❌ No garages found matching "${searchTerm}"`);
      await prisma.$disconnect();
      return;
    }

    if (garages.length > 1) {
      console.log('⚠️  Multiple garages found:\n');
      garages.forEach((garage, index) => {
        console.log(`${index + 1}. ${garage.name}`);
        console.log(`   ID: ${garage.id}`);
        console.log(`   Calls: ${garage._count.calls}\n`);
      });
      console.log('Please be more specific with the search term.');
      await prisma.$disconnect();
      return;
    }

    const garage = garages[0];
    console.log(`✅ Found garage: ${garage.name}`);
    console.log(`   ID: ${garage.id}`);
    console.log(`   Calls: ${garage._count.calls}\n`);

    if (garage._count.calls === 0) {
      console.log('✅ No calls to delete');
      await prisma.$disconnect();
      return;
    }

    console.log(`⚠️  About to delete ${garage._count.calls} calls for ${garage.name}`);
    console.log('Press Ctrl+C to cancel, or wait 5 seconds to proceed...\n');
    
    await new Promise(resolve => setTimeout(resolve, 5000));

    console.log('🗑️  Deleting calls...');

    const result = await prisma.call.deleteMany({
      where: { garageId: garage.id }
    });

    console.log(`✅ Successfully deleted ${result.count} calls for ${garage.name}`);

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

deleteGarageCalls();
