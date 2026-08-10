import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
  datasourceUrl: 'postgresql://dbmasteruser:%7E3M%25D2%3Bp%297%5EhM%7CuB%2BC5%24EYZE%2CNox%23%7BZ8@ls-281c9aa8031025cec61d04cf3703c2d204e0d46a.cd6amiqi2i0k.eu-west-2.rds.amazonaws.com:5432/dbname?schema=public'
});

const calls = await prisma.call.findMany({
  where: { garageId: 'd51dfa55-15d0-4d60-ad81-c675579d16f6' },
  orderBy: { createdAt: 'desc' },
  take: 3
});

console.log('Last 3 calls:');
for (const call of calls) {
  const transcript = Array.isArray(call.transcript) ? call.transcript : JSON.parse(call.transcript);
  const toolCalls = transcript.filter(e => e.type === 'tool_call');
  console.log(`\nCall ${call.id} - ${new Date(call.createdAt).toISOString()}`);
  console.log(`  Transcript entries: ${transcript.length}`);
  console.log(`  Tool calls: ${toolCalls.length}`);
  if (toolCalls.length > 0) {
    toolCalls.forEach((tc, i) => console.log(`    ${i+1}. ${tc.tool}`));
  }
}

await prisma.$disconnect();
