import { PrismaClient } from '../backend/node_modules/.prisma/client/index.js';

const prisma = new PrismaClient();

interface TranscriptItem {
  text?: string;
  type: string;
  speaker?: string;
  timestamp?: number;
  tool?: string;
  result?: any;
}

async function analyzeRegistrationRetries() {
  try {
    // Get calls from last 24 hours
    const twentyFourHoursAgo = new Date();
    twentyFourHoursAgo.setHours(twentyFourHoursAgo.getHours() - 24);
    
    const now = new Date();

    console.log(`\n📊 Analyzing calls from ${twentyFourHoursAgo.toLocaleString()} to ${now.toLocaleString()}\n`);

    const calls = await prisma.call.findMany({
      where: {
        createdAt: {
          gte: twentyFourHoursAgo,
          lte: now,
        },
        customerPhone: {
          not: '+447976500282',
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

    console.log(`Found ${calls.length} calls in the last 24 hours\n`);

    let totalCalls = 0;
    let callsWithRegLookup = 0;
    let callsWithMultipleRetries = 0;
    
    // Issue counters
    let partialCaptureCount = 0;
    let notFoundCount = 0;
    let threeOrMoreAttemptsCount = 0;
    
    const retryDetails: Array<{
      id: string;
      garage: string;
      customer: string;
      time: string;
      reg: string;
      attempts: number;
      notFoundCount: number;
      messages: string[];
    }> = [];

    for (const call of calls) {
      totalCalls++;
      const transcript = call.transcript as any;
      
      // Convert to array - transcript is stored as object with numeric keys
      let items: TranscriptItem[] = [];
      if (Array.isArray(transcript)) {
        items = transcript;
      } else if (transcript && typeof transcript === 'object') {
        items = Object.values(transcript);
      }
      
      if (items.length === 0) continue;

      // Count how many times agent said "I'm not finding that one" or similar
      const regNotFoundMessages = items.filter(
        (item) =>
          item.type === 'message' &&
          item.speaker === 'agent' &&
          item.text &&
          (item.text.toLowerCase().includes("not finding that") ||
          item.text.toLowerCase().includes("i'm having trouble finding") ||
          item.text.toLowerCase().includes("having trouble finding"))
      );

      // Count phonetic readback attempts (when agent says NATO phonetics with "Is that right?")
      const natoPhonetics = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 
                             'Hotel', 'India', 'Juliet', 'Kilo', 'Lima', 'Mike', 'November', 
                             'Oscar', 'Papa', 'Quebec', 'Romeo', 'Sierra', 'Tango', 'Uniform', 
                             'Victor', 'Whiskey', 'Xray', 'Yankee', 'Zulu'];
      
      const readbackMessages = items.filter(
        (item) =>
          item.type === 'message' &&
          item.speaker === 'agent' &&
          item.text &&
          natoPhonetics.some(phonetic => item.text!.includes(phonetic)) &&
          item.text.toLowerCase().includes('is that right')
      );

      const hasRegLookup = readbackMessages.length > 0;
      if (hasRegLookup) {
        callsWithRegLookup++;
      }

      const attempts = readbackMessages.length;
      const callNotFoundCount = regNotFoundMessages.length;
      
      if (attempts > 1 || callNotFoundCount > 0) {
        callsWithMultipleRetries++;
        
        // Track issue types
        if (callNotFoundCount > 0) notFoundCount++;
        if (attempts >= 3) threeOrMoreAttemptsCount++;
        
        // Check for partial capture (first readback has < 5 characters of NATO phonetics)
        if (readbackMessages.length > 0) {
          const firstReadback = readbackMessages[0].text || '';
          const natoCount = natoPhonetics.filter(p => firstReadback.includes(p)).length;
          if (natoCount < 5) partialCaptureCount++;
        }
        
        const relevantMessages: string[] = [];
        for (const item of items) {
          if (item.type === 'message' && item.speaker === 'agent' && item.text) {
            const text = item.text;
            if (
              text.toLowerCase().includes('not finding') ||
              text.toLowerCase().includes('trouble finding') ||
              text.toLowerCase().includes('read it out again') ||
              text.toLowerCase().includes('spell it out') ||
              (natoPhonetics.some(p => text.includes(p)) && text.toLowerCase().includes('right'))
            ) {
              relevantMessages.push(text);
            }
          }
        }

        retryDetails.push({
          id: call.id,
          garage: call.garage?.name || 'Unknown',
          customer: call.customerName || 'Unknown',
          reg: call.registrationNumber || 'N/A',
          time: call.createdAt.toLocaleTimeString(),
          attempts,
          notFoundCount: callNotFoundCount,
          messages: relevantMessages.slice(0, 6),
        });
      }
    }

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📈 SUMMARY');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`Total calls: ${totalCalls}`);
    console.log(`Calls with registration lookup: ${callsWithRegLookup}`);
    console.log(`Calls requiring multiple attempts: ${callsWithMultipleRetries}`);
    if (callsWithRegLookup > 0) {
      console.log(`Success rate (1st attempt): ${(((callsWithRegLookup - callsWithMultipleRetries) / callsWithRegLookup) * 100).toFixed(1)}%`);
      console.log(`Retry rate: ${((callsWithMultipleRetries / callsWithRegLookup) * 100).toFixed(1)}%`);
    }
    console.log(`\n`);
    
    if (callsWithMultipleRetries > 0) {
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('🔍 COMMON ISSUES BREAKDOWN');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(`Partial capture (< 5 chars on 1st attempt): ${partialCaptureCount} (${((partialCaptureCount / callsWithMultipleRetries) * 100).toFixed(1)}%)`);
      console.log(`"Not finding" errors: ${notFoundCount} (${((notFoundCount / callsWithMultipleRetries) * 100).toFixed(1)}%)`);
      console.log(`3+ attempts needed: ${threeOrMoreAttemptsCount} (${((threeOrMoreAttemptsCount / callsWithMultipleRetries) * 100).toFixed(1)}%)`);
      console.log(`\n`);
    }

    if (retryDetails.length > 0) {
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('🔍 CALLS WITH MULTIPLE REGISTRATION ATTEMPTS');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      
      for (const detail of retryDetails) {
        console.log(`📞 Call ID: ${detail.id}`);
        console.log(`🏪 Garage: ${detail.garage}`);
        console.log(`👤 Customer: ${detail.customer}`);
        console.log(`🚗 Final Reg: ${detail.reg}`);
        console.log(`🕐 Time: ${detail.time}`);
        console.log(`🔄 Readback attempts: ${detail.attempts}`);
        console.log(`❌ "Not finding" messages: ${detail.notFoundCount}`);
        console.log(`📝 Key messages:`);
        detail.messages.forEach((msg, i) => {
          const shortened = msg.length > 120 ? msg.substring(0, 120) + '...' : msg;
          console.log(`   ${i + 1}. ${shortened}`);
        });
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      }
    } else {
      console.log('✅ No registration retry issues found in the last 24 hours!\n');
    }

  } catch (error) {
    console.error('Error analyzing calls:', error);
  } finally {
    await prisma.$disconnect();
  }
}

analyzeRegistrationRetries();
