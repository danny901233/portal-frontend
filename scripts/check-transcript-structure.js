const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function checkTranscript() {
  try {
    // Get the most recent call
    const call = await prisma.call.findFirst({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        fromNumber: true,
        createdAt: true,
        transcript: true
      }
    });

    if (!call) {
      console.log('No calls found');
      return;
    }

    console.log(`Most recent call: ${call.id}`);
    console.log(`From: ${call.fromNumber}`);
    console.log(`Created: ${call.createdAt}`);

    const transcript = call.transcript;
    
    if (!Array.isArray(transcript)) {
      console.log('Transcript is not an array!');
      console.log('Type:', typeof transcript);
      return;
    }

    console.log(`Total transcript entries: ${transcript.length}\n`);

    // Count entry types
    const types = {};
    transcript.forEach(entry => {
      const type = entry.type || 'message';
      types[type] = (types[type] || 0) + 1;
    });

    console.log('Entry types:');
    Object.entries(types).forEach(([type, count]) => {
      console.log(`  ${type}: ${count}`);
    });

    // Show first few entries
    console.log('\nFirst 5 entries:');
    transcript.slice(0, 5).forEach((entry, i) => {
      console.log(`\n${i + 1}. Type: ${entry.type || 'message'}`);
      if (entry.type === 'tool_call') {
        console.log(`   Tool: ${entry.tool || 'unknown'}`);
        console.log(`   Success: ${entry.success}`);
      } else if (entry.type === 'log') {
        console.log(`   Level: ${entry.level}`);
        console.log(`   Message: ${entry.message?.substring(0, 50)}...`);
      } else {
        console.log(`   Speaker: ${entry.speaker}`);
        console.log(`   Text: ${entry.text?.substring(0, 50)}...`);
      }
    });

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

checkTranscript();
