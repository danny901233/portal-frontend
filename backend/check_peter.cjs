const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const calls = await prisma.call.findMany({
    where: {
      customerName: { contains: 'Peter Young', mode: 'insensitive' },
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, createdAt: true, garageId: true, customerPhone: true, durationSeconds: true, callType: true, summary: true, transcript: true, customerName: true, registrationNumber: true },
  });

  console.log(`Found ${calls.length} calls with customerName containing "Peter Young"`);
  for (const c of calls) {
    const g = await prisma.garage.findUnique({ where: { id: c.garageId }, select: { name: true, agentConfiguration: { select: { agentScript: true } } } });
    const turns = Array.isArray(c.transcript) ? c.transcript.length : 0;
    const userTurns = Array.isArray(c.transcript) ? c.transcript.filter(t => t.speaker === 'user' || t.speaker === 'customer').length : 0;
    console.log(`\n[${c.createdAt.toISOString()}] id=${c.id} ${g?.name} (${g?.agentConfiguration?.agentScript})`);
    console.log(`  phone=${c.customerPhone} dur=${c.durationSeconds}s turns=${turns} userTurns=${userTurns} type=${c.callType}`);
    console.log(`  reg=${c.registrationNumber}`);
    console.log(`  summary: ${(c.summary || '').slice(0, 300)}`);
    if (turns > 0 && turns < 20) {
      console.log(`  ALL TURNS:`);
      for (const t of c.transcript) {
        console.log(`    [${t.timestamp?.toFixed?.(2) ?? '?'}] ${t.speaker || t.role}: ${(t.text||'').slice(0, 120)}`);
      }
    } else if (turns >= 20) {
      console.log(`  FIRST 5 + LAST 5 TURNS:`);
      const xs = [...c.transcript.slice(0, 5), '...', ...c.transcript.slice(-5)];
      for (const t of xs) {
        if (t === '...') { console.log('    ...'); continue; }
        console.log(`    [${t.timestamp?.toFixed?.(2) ?? '?'}] ${t.speaker || t.role}: ${(t.text||'').slice(0, 120)}`);
      }
    }
  }
}
main().catch(e=>{console.error(e);process.exit(1);}).finally(()=>prisma.$disconnect());
