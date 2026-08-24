import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function listRecentCalls() {
  try {
    const calls = await prisma.call.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        roomName: true,
        createdAt: true,
        customerName: true,
        callType: true,
        durationSeconds: true,
      },
    });

    console.log(`\nFound ${calls.length} recent calls:\n`);
    calls.forEach((call, i) => {
      console.log(
        `${i + 1}. ID: ${call.id} | Room: ${call.roomName} | ` +
        `Customer: ${call.customerName || 'N/A'} | ` +
        `Type: ${call.callType} | ` +
        `Duration: ${call.durationSeconds}s | ` +
        `Created: ${call.createdAt.toISOString()}`
      );
    });

    // Search for calls with ID containing the pattern
    const searchId = process.argv[2];
    if (searchId) {
      console.log(`\n\nSearching for calls with ID containing "${searchId}"...`);
      const matchingCalls = calls.filter(c => c.id.includes(searchId));
      if (matchingCalls.length > 0) {
        console.log(`Found ${matchingCalls.length} matching calls:`);
        matchingCalls.forEach(c => console.log(`- ${c.id}`));
      } else {
        console.log('No matching calls found');
      }
    }

  } catch (error) {
    console.error('Error fetching calls:', error);
  } finally {
    await prisma.$disconnect();
  }
}

listRecentCalls();
