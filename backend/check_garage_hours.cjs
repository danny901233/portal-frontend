const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  try {
    const garage = await prisma.garage.findUnique({
      where: { id: '076ad334-d70c-452d-b42a-e102ec96569f' },
      select: {
        name: true,
        id: true,
        agentConfiguration: {
          select: {
            weeklyOpeningHours: true,
            holidayClosures: true
          }
        }
      }
    });

    if (!garage) {
      console.log('Garage not found');
      process.exit(1);
    }

    console.log('\n=== GARAGE DETAILS ===');
    console.log('Garage ID:', garage.id);
    console.log('Garage Name:', garage.name);

    console.log('\n=== WEEKLY OPENING HOURS (Raw Data) ===');
    console.log(JSON.stringify(garage.agentConfiguration?.weeklyOpeningHours, null, 2));

    console.log('\n=== FORMATTED OPENING HOURS ===');
    const hours = garage.agentConfiguration?.weeklyOpeningHours;
    if (hours && typeof hours === 'object') {
      const dayOrder = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
      dayOrder.forEach(day => {
        const dayHours = hours[day];
        if (!dayHours) {
          console.log(`${day.charAt(0).toUpperCase() + day.slice(1)}: Not configured`);
        } else if (dayHours.closed) {
          console.log(`${day.charAt(0).toUpperCase() + day.slice(1)}: Closed`);
        } else {
          const open = dayHours.open || 'N/A';
          const close = dayHours.close || 'N/A';
          console.log(`${day.charAt(0).toUpperCase() + day.slice(1)}: ${open} - ${close}`);
        }
      });
    } else {
      console.log('No opening hours configured');
    }

    console.log('\n=== HOLIDAY CLOSURES ===');
    console.log(garage.agentConfiguration?.holidayClosures || 'None configured');

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await prisma.$disconnect();
  }
})();
