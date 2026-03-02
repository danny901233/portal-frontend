import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function listGarages() {
  try {
    const garages = await prisma.garage.findMany({
      include: {
        agentConfiguration: {
          select: {
            branchName: true
          }
        },
        _count: {
          select: {
            calls: true
          }
        }
      }
    });

    console.log(`\n📋 Found ${garages.length} garages:\n`);

    garages.forEach((garage, index) => {
      const displayName = garage.agentConfiguration?.branchName || garage.name;
      console.log(`${index + 1}. ${displayName}`);
      console.log(`   ID: ${garage.id}`);
      console.log(`   Name: ${garage.name}`);
      console.log(`   Calls: ${garage._count.calls}`);
      console.log('');
    });

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

listGarages();
