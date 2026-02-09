const { PrismaClient } = require('@prisma/client');
require('dotenv').config({ path: '.env' });

const prisma = new PrismaClient();

async function findCall() {
  // Find calls from today with caller name "Actually"
  const calls = await prisma.call.findMany({
    where: {
      callerName: 'Actually',
      createdAt: {
        gte: new Date('2026-02-06T00:00:00Z')
      }
    },
    orderBy: { createdAt: 'desc' },
    take: 5
  });

  for (const call of calls) {
    console.log('\n=== CALL ===');
    console.log('ID:', call.id);
    console.log('Caller Name:', call.callerName);
    console.log('Created:', call.createdAt);
    console.log('Transcript Events:', JSON.stringify(call.transcriptEvents, null, 2));
  }

  await prisma.$disconnect();
}

findCall().catch(console.error);
