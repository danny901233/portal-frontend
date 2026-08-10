import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
  datasourceUrl: 'postgresql://dbmasteruser:%7E3M%25D2%3Bp%297%5EhM%7CuB%2BC5%24EYZE%2CNox%23%7BZ8@ls-281c9aa8031025cec61d04cf3703c2d204e0d46a.cd6amiqi2i0k.eu-west-2.rds.amazonaws.com:5432/dbname?schema=public'
});

const call = await prisma.call.findUnique({
  where: { id: '60051786' }
});

if (!call) {
  console.log('Call not found');
  process.exit(1);
}

const transcript = Array.isArray(call.transcript) ? call.transcript : JSON.parse(call.transcript);
console.log(`Total entries: ${transcript.length}`);
console.log('\nFirst 15 entries:');

for (let i = 0; i < Math.min(15, transcript.length); i++) {
  const entry = transcript[i];
  const type = entry.type || 'NO TYPE';
  
  if (type === 'tool_call') {
    console.log(`${i}: TOOL_CALL - ${entry.tool || 'unknown'}`);
  } else if (type === 'message' || !entry.type) {
    console.log(`${i}: MESSAGE - ${entry.speaker}: ${(entry.text || '').substring(0, 40)}`);
  } else {
    console.log(`${i}: ${type}`);
  }
}

await prisma.$disconnect();
