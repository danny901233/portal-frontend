const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  try {
    console.log('=== RECENT CALLS (Last 20) ===\n');

    const calls = await prisma.call.findMany({
      take: 20,
      orderBy: {
        createdAt: 'desc'
      },
      select: {
        id: true,
        createdAt: true,
        customerPhone: true,
        durationSeconds: true,
        callType: true,
        garage: {
          select: {
            name: true
          }
        }
      }
    });

    calls.forEach(call => {
      const date = new Date(call.createdAt).toLocaleString();
      const duration = call.durationSeconds ? `${call.durationSeconds}s` : 'N/A';
      console.log(`ID: ${call.id} | ${call.garage?.name || 'No garage'} | ${date} | ${duration} | ${call.callType || 'unknown'}`);
    });

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await prisma.$disconnect();
  }
})();
