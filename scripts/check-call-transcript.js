const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function getCall() {
  const callId = process.argv[2] || '33595181';
  
  const call = await prisma.call.findUnique({
    where: { id: callId },
    select: {
      id: true,
      garageId: true,
      customerName: true,
      transcript: true,
      createdAt: true,
      garage: {
        select: { name: true }
      }
    }
  });
  
  if (!call) {
    console.log('Call not found');
    return;
  }
  
  console.log('Call ID:', call.id);
  console.log('Garage:', call.garage.name);
  console.log('Customer:', call.customerName);
  console.log('Date:', call.createdAt.toISOString());
  console.log('\n=== TRANSCRIPT ===\n');
  
  if (Array.isArray(call.transcript)) {
    call.transcript.forEach((entry, i) => {
      const role = entry.role || entry.speaker || 'unknown';
      const text = entry.text || entry.content || '';
      console.log(`[${i}] ${role.toUpperCase()}: ${text}`);
    });
  } else {
    console.log(JSON.stringify(call.transcript, null, 2));
  }
  
  await prisma.$disconnect();
}

getCall().catch(console.error);
