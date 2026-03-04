import { PrismaClient } from '../backend/node_modules/.prisma/client/index.js';

const prisma = new PrismaClient();

async function deleteCallsByGarageId() {
  try {
    const garageId = '04554f06-6617-4eb0-915e-754daa1435c2'; // VWGS garage ID from previous logs
    
    console.log(`🔍 Finding garage with ID: ${garageId}\n`);

    const garage = await prisma.garage.findUnique({
      where: {
        id: garageId
      },
      include: {
        _count: {
          select: {
            calls: true
          }
        }
      }
    });

    if (!garage) {
      console.log(`❌ Garage not found with ID: ${garageId}`);
      await prisma.$disconnect();
      return;
    }

    console.log(`✅ Found garage: ${garage.name}`);
    console.log(`   ID: ${garage.id}`);
    console.log(`   Calls to delete: ${garage._count.calls}\n`);

    if (garage._count.calls === 0) {
      console.log('✅ No calls to delete');
      await prisma.$disconnect();
      return;
    }

    console.log('🗑️  Deleting calls...\n');

    const result = await prisma.call.deleteMany({
      where: {
        garageId: garageId
      }
    });

    console.log(`✅ Successfully deleted ${result.count} calls for ${garage.name}`);
    await prisma.$disconnect();
  } catch (error) {
    console.error('❌ Error:', error);
    await prisma.$disconnect();
    process.exit(1);
  }
}

deleteCallsByGarageId();
