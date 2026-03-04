const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  try {
    console.log('=== SEARCHING FOR MPB 4X4 GARAGE ===\n');

    const garages = await prisma.garage.findMany({
      where: {
        name: {
          contains: 'MPB',
          mode: 'insensitive'
        }
      },
      select: {
        id: true,
        name: true,
        agentConfiguration: {
          select: {
            weeklyOpeningHours: true,
            holidayClosures: true
          }
        }
      }
    });

    if (garages.length === 0) {
      console.log('No garages found with "MPB" in the name.\n');

      // Try searching for 4X4
      const garages2 = await prisma.garage.findMany({
        where: {
          name: {
            contains: '4X4',
            mode: 'insensitive'
          }
        },
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

      if (garages2.length > 0) {
        console.log('Found garages with "4X4" in name:');
        garages2.forEach(g => {
          console.log(`  - ${g.name} (${g.id})`);
        });
      } else {
        console.log('No garages found with "4X4" in the name either.');
      }

      process.exit(0);
    }

    garages.forEach(garage => {
      console.log(`Garage: ${garage.name}`);
      console.log(`ID: ${garage.id}`);
      console.log('\nWeekly Opening Hours:');
      console.log(JSON.stringify(garage.agentConfiguration?.weeklyOpeningHours, null, 2));
      console.log('\nHoliday Closures:');
      console.log(garage.agentConfiguration?.holidayClosures || 'None');
      console.log('\n---\n');
    });

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await prisma.$disconnect();
  }
})();
