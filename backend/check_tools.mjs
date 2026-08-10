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
console.log(`Total entries: ${transcript.length}\n`);

// Show all entries with their timestamps
console.log('All entries in order:');
transcript.forEach((entry, i) => {
  const type = entry.type || 'message';
  const ts = entry.timestamp || 0;
  
  if (type === 'tool_call') {
    console.log(`${i}: [${ts}] TOOL: ${entry.tool}`);
  } else if (type === 'message') {
    const text = (entry.text || '').substring(0, 40);
    console.log(`${i}: [${ts}] MSG (${entry.speaker}): ${text}`);
  } else {
    console.log(`${i}: [${ts}] ${type}`);
  }
});

console.log('\nTool calls found:');
const toolCalls = transcript.filter(e => e.type === 'tool_call');
toolCalls.forEach(tc => {
  console.log(`  - ${tc.tool} at timestamp ${tc.timestamp}`);
});

await prisma.$disconnect();
