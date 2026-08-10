const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkTranscript() {
  try {
    const call = await prisma.call.findFirst({
      orderBy: { createdAt: 'desc' }
    });

    if (!call) {
      console.log('No calls found');
      return;
    }

    console.log(`Call ID: ${call.id}`);
    console.log(`Created: ${call.createdAt}`);

    const transcript = call.transcript;
    if (!Array.isArray(transcript)) {
      console.log('\nTranscript is NOT an array!');
      console.log('Type:', typeof transcript);
      return;
    }

    console.log(`\nTotal transcript entries: ${transcript.length}`);

    // Count entry types
    const types = {};
    transcript.forEach(entry => {
      const type = entry.type || 'message';
      types[type] = (types[type] || 0) + 1;
    });

    console.log('\nEntry types breakdown:');
    Object.entries(types).forEach(([type, count]) => {
      console.log(`  ${type}: ${count}`);
    });

    // Show first 5 entries
    console.log('\nFirst 5 entries:');
    transcript.slice(0, 5).forEach((entry, i) => {
      const type = entry.type || 'message';
      console.log(`\n${i + 1}. Type: ${type}`);
      if (type === 'message') {
        console.log(`   Role: ${entry.role}`);
        console.log(`   Content: ${entry.content?.substring(0, 80)}...`);
      } else if (type === 'tool_call') {
        console.log(`   Tool: ${entry.tool_name}`);
        console.log(`   Duration: ${entry.duration_ms}ms`);
      } else if (type === 'log') {
        console.log(`   Level: ${entry.level}`);
        console.log(`   Message: ${entry.message?.substring(0, 80)}...`);
      }
    });

    await prisma.$disconnect();
  } catch (error) {
    console.error('Error:', error.message);
    await prisma.$disconnect();
  }
}

checkTranscript();
