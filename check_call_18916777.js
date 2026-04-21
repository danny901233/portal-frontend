const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const call = await prisma.call.findUnique({
    where: { id: '18916777' },
    select: {
      id: true,
      garageId: true,
      transcript: true,
      createdAt: true,
      metrics: true,
      garage: { select: { name: true } }
    }
  });
  
  if (!call) {
    console.log('Call 18916777 not found');
    process.exit(1);
  }
  
  console.log('Call ID:', call.id);
  console.log('Garage:', call.garage.name);
  console.log('Date:', call.createdAt.toISOString());
  
  // Extract customer name from metrics if available
  const metrics = call.metrics;
  if (metrics && typeof metrics === 'object') {
    console.log('VRN Captured:', metrics.vrn_captured);
    console.log('VRN Attempts:', metrics.vrn_attempts);
  }
  
  console.log('\n=== TRANSCRIPT ===\n');
  
  if (Array.isArray(call.transcript)) {
    call.transcript.forEach((entry, i) => {
      const role = entry.role || entry.speaker || 'unknown';
      const text = entry.text || entry.content || '';
      console.log(`[${i}] ${role.toUpperCase()}: ${text}`);
    });
  }
  
  await prisma.$disconnect();
})();
