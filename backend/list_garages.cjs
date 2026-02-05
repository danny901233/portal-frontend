const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  try {
    console.log('=== ALL GARAGES ===\n');

    const garages = await prisma.garage.findMany({
      select: {
        id: true,
        name: true,
        agentConfiguration: {
          select: {
            weeklyOpeningHours: true
          }
        }
      }
    });

    console.log(`Found ${garages.length} garages:\n`);

    garages.forEach(garage => {
      console.log(`ID: ${garage.id}`);
      console.log(`Name: ${garage.name}`);
      const hasHours = garage.agentConfiguration?.weeklyOpeningHours ? 'Yes' : 'No';
      console.log(`Has opening hours configured: ${hasHours}`);
      console.log('---');
    });

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await prisma.$disconnect();
  }
})();
