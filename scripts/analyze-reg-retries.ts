import { PrismaClient } from '../backend/node_modules/.prisma/client/index.js';

const prisma = new PrismaClient();

interface CallTranscript {
  items?: Array<{
    type: string;
    content?: string[];
    role?: string;
  }>;
}

async function analyzeRegistrationRetries() {
  try {
    // Get calls from last 7 days
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    sevenDaysAgo.setHours(0, 0, 0, 0);
    
    const now = new Date();

    const calls = await prisma.call.findMany({
      where: {
        createdAt: {
          gte: sevenDaysAgo,
          lte: now,
        },
      },
      select: {
        id: true,
        roomName: true,
        customerName: true,
        registrationNumber: true,
        transcript: true,
        createdAt: true,
        garage: {
          select: {
            name: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    console.log(`\n📊 Analyzing ${calls.length} calls from today (${startOfToday.toLocaleDateString()})\n`);

    let totalCalls = 0;
    let callsWithRegLookup = 0;
    let callsWithMultipleRetries = 0;
    const retryDetails: Array<{
      id: string;
      garage: string;
      customer: string;
      time: string;
      attempts: number;
      messages: string[];
    }> = [];

    for (const call of calls) {
      totalCalls++;
      const transcript = call.transcript as CallTranscript;
      
      if (!transcript?.items) continue;

      // Count how many times agent asked "I'm not finding that one" or similar
      const regNotFoundMessages = transcript.items.filter(
        (item) =>
          item.type === 'message' &&
          item.role === 'assistant' &&
          item.content?.some((c) =>
            c.toLowerCase().includes("not finding that") ||
            c.toLowerCase().includes("read it out again") ||
            c.toLowerCase().includes("spell it out letter by letter")
          )
      );

      // Count confirmed lookup attempts (when agent says "Is that right?" after reading back)
      const readbackMessages = transcript.items.filter(
        (item) =>
          item.type === 'message' &&
          item.role === 'assistant' &&
          item.content?.some((c) =>
            (c.includes('Alpha') || c.includes('Bravo') || c.includes('Charlie')) &&
            c.toLowerCase().includes('is that right')
          )
      );

      const hasRegLookup = readbackMessages.length > 0;
      if (hasRegLookup) {
        callsWithRegLookup++;
      }

      const attempts = readbackMessages.length;
      
      if (attempts > 1 || regNotFoundMessages.length > 0) {
        callsWithMultipleRetries++;
        
        const relevantMessages: string[] = [];
        for (const item of transcript.items) {
          if (item.type === 'message' && item.role === 'assistant' && item.content) {
            const content = item.content.join(' ');
            if (
              content.toLowerCase().includes('not finding') ||
              content.toLowerCase().includes('registration') ||
              (content.includes('Alpha') && content.includes('right'))
            ) {
              relevantMessages.push(content);
            }
          }
        }

        retryDetails.push({
          id: call.id,
          garage: call.garage?.name || 'Unknown',
          customer: call.customerName || 'Unknown',
          time: call.createdAt.toLocaleTimeString(),
          attempts,
          messages: relevantMessages.slice(0, 5), // First 5 relevant messages
        });
      }
    }

    console.log('📈 Summary:');
    console.log(`Total calls today: ${totalCalls}`);
    console.log(`Calls with registration lookup: ${callsWithRegLookup}`);
    console.log(`Calls with multiple reg attempts: ${callsWithMultipleRetries} (${((callsWithMultipleRetries / callsWithRegLookup) * 100).toFixed(1)}%)`);
    console.log(`\n`);

    if (retryDetails.length > 0) {
      console.log('🔍 Calls with multiple registration attempts:\n');
      for (const detail of retryDetails) {
        console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        console.log(`🏪 Garage: ${detail.garage}`);
        console.log(`👤 Customer: ${detail.customer}`);
        console.log(`🕐 Time: ${detail.time}`);
        console.log(`🔄 Readback attempts: ${detail.attempts}`);
        console.log(`📝 Key messages:`);
        detail.messages.forEach((msg, i) => {
          console.log(`   ${i + 1}. ${msg.substring(0, 100)}${msg.length > 100 ? '...' : ''}`);
        });
        console.log('');
      }
    }

  } catch (error) {
    console.error('Error analyzing calls:', error);
  } finally {
    await prisma.$disconnect();
  }
}

analyzeRegistrationRetries();
