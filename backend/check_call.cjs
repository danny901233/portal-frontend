const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  try {
    // Try as string
    let call = await prisma.call.findUnique({
      where: { id: '60625714' },
      include: {
        garage: {
          select: {
            name: true,
            id: true,
            agentConfiguration: {
              select: {
                weeklyOpeningHours: true
              }
            }
          }
        }
      }
    });

    if (!call) {
      console.log('Call 60625714 not found. Searching for similar IDs...');
      const similarCalls = await prisma.call.findMany({
        where: {
          id: {
            contains: '6062571'
          }
        },
        select: {
          id: true,
          createdAt: true,
          customerPhone: true
        },
        take: 10,
        orderBy: {
          createdAt: 'desc'
        }
      });
      console.log('Similar call IDs found:', similarCalls.length);
      similarCalls.forEach(c => {
        console.log(`  - ID: ${c.id}, Phone: ${c.customerPhone}, Created: ${c.createdAt}`);
      });
      process.exit(1);
    }

    console.log('\n=== CALL DETAILS ===');
    console.log('Call ID:', call.id);
    console.log('Garage:', call.garage?.name);
    console.log('Garage ID:', call.garage?.id);
    console.log('Phone:', call.customerPhone);
    console.log('Duration:', call.durationSeconds, 'seconds');
    console.log('Room:', call.roomName);
    console.log('Created:', call.createdAt);

    console.log('\n=== GARAGE OPENING HOURS ===');
    console.log(JSON.stringify(call.garage?.agentConfiguration?.weeklyOpeningHours, null, 2));

    console.log('\n=== TRANSCRIPT (searching for opening hours mentions) ===');
    const transcript = call.transcript ? JSON.parse(JSON.stringify(call.transcript)) : [];
    transcript.forEach((msg, idx) => {
      const text = msg.text || '';
      // Look for mentions of opening hours, time, open, close
      if (text.match(/open|close|hour|am|pm|7|8|45/i)) {
        console.log(`[${idx}] [${msg.speaker}]: ${text}`);
      }
    });

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await prisma.$disconnect();
  }
})();
