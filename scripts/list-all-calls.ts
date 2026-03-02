import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function listAllCalls() {
  try {
    const calls = await prisma.call.findMany({
      take: 100,
      orderBy: {
        createdAt: 'desc'
      },
      include: {
        garage: {
          select: {
            id: true,
            name: true
          }
        }
      }
    });

    console.log(`\n📞 Found ${calls.length} recent calls:\n`);

    if (calls.length === 0) {
      console.log('No calls found in the database.');
      await prisma.$disconnect();
      return;
    }

    // Group by garage
    const garageGroups = calls.reduce((acc, call) => {
      const garageId = call.garageId;
      if (!acc[garageId]) {
        acc[garageId] = {
          garageName: call.garage?.name || 'Unknown',
          garageId: garageId,
          calls: []
        };
      }
      acc[garageId].calls.push(call);
      return acc;
    }, {} as Record<string, any>);

    Object.values(garageGroups).forEach((group: any) => {
      console.log(`🏢 ${group.garageName}`);
      console.log(`   Garage ID: ${group.garageId}`);
      console.log(`   Calls: ${group.calls.length}`);
      console.log(`   Latest: ${group.calls[0].createdAt.toLocaleString()}\n`);
    });

    // Ask which garage to delete
    console.log('\n💡 To delete calls for a specific garage, note the Garage ID above.');

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

listAllCalls();
