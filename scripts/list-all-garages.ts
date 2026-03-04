import { PrismaClient } from '../backend/node_modules/.prisma/client/index.js';

const prisma = new PrismaClient();

async function listAllGarages() {
  try {
    const garages = await prisma.garage.findMany({
      include: {
        _count: {
          select: {
            calls: true
          }
        }
      },
      orderBy: {
        name: 'asc'
      }
    });

    console.log(`\n📋 Found ${garages.length} garages:\n`);

    garages.forEach((garage, index) => {
      console.log(`${index + 1}. ${garage.name}`);
      console.log(`   ID: ${garage.id}`);
      console.log(`   Calls: ${garage._count.calls}`);
      console.log();
    });

    await prisma.$disconnect();
  } catch (error) {
    console.error('❌ Error:', error);
    await prisma.$disconnect();
    process.exit(1);
  }
}

listAllGarages();
