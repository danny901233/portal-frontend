import { PrismaClient } from '../backend/node_modules/.prisma/client/index.js';

const prisma = new PrismaClient();

async function findGarage() {
  try {
    // Search by email
    const user = await prisma.user.findUnique({
      where: {
        email: 'chris@vwgs.uk'
      }
    });

    if (!user) {
      console.log('❌ User not found');
      await prisma.$disconnect();
      return;
    }

    const garage = await prisma.garage.findUnique({
      where: {
        id: user.garageId
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
      console.log('❌ Garage not found');
      await prisma.$disconnect();
      return;
    }

    console.log('✅ Found garage:\n');
    console.log(`Name: ${garage.name}`);
    console.log(`ID: ${garage.id}`);
    console.log(`Calls: ${garage._count.calls}\n`);

    await prisma.$disconnect();
  } catch (error) {
    console.error('Error:', error);
    await prisma.$disconnect();
    process.exit(1);
  }
}

findGarage();
