const { PrismaClient } = require('../backend/node_modules/.prisma/client');

const prisma = new PrismaClient();

async function investigateCallMixup() {
  console.log('🔍 Investigating Call Recording Mixup...\n');

  // Check Call ID 95469110
  console.log('=== Checking Call ID 95469110 ===');
  const call95469110 = await prisma.call.findUnique({
    where: { id: '95469110' },
    include: {
      garage: {
        select: {
          id: true,
          name: true,
          businessName: true,
        }
      }
    }
  });

  if (call95469110) {
    console.log('Call found:');
    console.log(`- Call ID: ${call95469110.id}`);
    console.log(`- Garage ID: ${call95469110.garageId}`);
    console.log(`- Garage Name: ${call95469110.garage?.name || call95469110.garage?.businessName}`);
    console.log(`- Recording URL: ${call95469110.recordingUrl}`);
    console.log(`- Recording SID: ${call95469110.recordingSid}`);
    console.log(`- Created At: ${call95469110.createdAt}`);
    console.log(`- Duration: ${call95469110.duration} seconds`);
  } else {
    console.log('❌ Call ID 95469110 NOT FOUND');
  }

  console.log('\n=== Checking for calls from Garage 80902607 ===');
  const garage80902607Calls = await prisma.call.findMany({
    where: { 
      garageId: '80902607'
    },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: {
      id: true,
      garageId: true,
      recordingUrl: true,
      recordingSid: true,
      createdAt: true,
      duration: true,
    }
  });

  if (garage80902607Calls.length > 0) {
    console.log(`Found ${garage80902607Calls.length} recent calls for garage 80902607:`);
    garage80902607Calls.forEach((call, idx) => {
      console.log(`\n${idx + 1}. Call ID: ${call.id}`);
      console.log(`   - Recording URL: ${call.recordingUrl}`);
      console.log(`   - Recording SID: ${call.recordingSid}`);
      console.log(`   - Created At: ${call.createdAt}`);
    });
  } else {
    console.log('No calls found for garage 80902607');
  }

  // Check if recording URL or SID contains references to the wrong garage
  console.log('\n=== Checking for recording URL/SID contamination ===');
  if (call95469110 && call95469110.recordingUrl) {
    if (call95469110.recordingUrl.includes('80902607') || call95469110.recordingSid?.includes('80902607')) {
      console.log('⚠️ CONTAMINATION DETECTED: Call 95469110 recording URL/SID references garage 80902607');
    }
  }

  // Search for any calls that might have wrong garage references in their recording data
  console.log('\n=== Searching for potential cross-contamination patterns ===');
  const allRecentCalls = await prisma.call.findMany({
    where: {
      OR: [
        { garageId: '80902607' },
        { id: '95469110' }
      ],
      recordingUrl: { not: null }
    },
    orderBy: { createdAt: 'desc' },
    take: 20,
    include: {
      garage: {
        select: {
          id: true,
          name: true,
        }
      }
    }
  });

  console.log(`\nFound ${allRecentCalls.length} calls with recordings:`);
  allRecentCalls.forEach((call) => {
    console.log(`\n- Call ID: ${call.id}`);
    console.log(`  Garage: ${call.garage?.name} (${call.garageId})`);
    console.log(`  Recording: ${call.recordingUrl?.substring(0, 80)}...`);
  });

  await prisma.$disconnect();
}

investigateCallMixup()
  .catch((error) => {
    console.error('Error:', error);
    process.exit(1);
  });
