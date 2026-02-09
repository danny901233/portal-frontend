const { PrismaClient } = require('@prisma/client');
require('dotenv').config({ path: '.env' });

const prisma = new PrismaClient();

async function listCalls() {
  const calls = await prisma.call.findMany({
    where: {
      createdAt: {
        gte: new Date('2026-02-06T11:00:00Z')
      }
    },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: {
      id: true,
      callerName: true,
      createdAt: true,
      callTag: true
    }
  });

  console.log('Recent calls since 11:00 UTC:');
  calls.forEach(call => {
    console.log(`\nID: ${call.id}`);
    console.log(`Name: ${call.callerName}`);
    console.log(`Tag: ${call.callTag}`);
    console.log(`Time: ${call.createdAt}`);
  });

  await prisma.$disconnect();
}

listCalls().catch(console.error);
