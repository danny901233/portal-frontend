const { PrismaClient } = require('@prisma/client');
require('dotenv').config({ path: '.env' });

const prisma = new PrismaClient();

async function fetchCall() {
  const callId = process.argv[2];
  if (!callId) {
    console.error('Usage: node fetch_call.cjs <call_id>');
    process.exit(1);
  }

  const call = await prisma.call.findUnique({
    where: { id: callId }
  });

  if (!call) {
    console.log('Call not found');
    process.exit(1);
  }

  console.log(JSON.stringify(call, null, 2));
  await prisma.$disconnect();
}

fetchCall().catch(console.error);
