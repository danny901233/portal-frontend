const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // Get all Assist garages
  const assistGarages = await prisma.garage.findMany({
    where: { agentConfiguration: { agentScript: 'Assist-agent' } },
    select: { id: true, name: true, agentConfiguration: { select: { greetingLine: true, voice: true } } },
  });
  const idToInfo = {};
  for (const g of assistGarages) idToInfo[g.id] = { name: g.name, greeting: g.agentConfiguration?.greetingLine, voice: g.agentConfiguration?.voice };

  console.log(`\n=== ${assistGarages.length} ASSIST GARAGES ===\n`);
  for (const g of assistGarages) console.log(`  ${g.name.padEnd(35)} voice=${g.agentConfiguration?.voice || '-'}  greeting="${(g.agentConfiguration?.greetingLine||'').slice(0,90)}"`);

  // All Assist calls today
  const calls = await prisma.call.findMany({
    where: {
      garageId: { in: assistGarages.map(g => g.id) },
      createdAt: { gte: new Date('2026-06-18T00:00:00Z') },
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, createdAt: true, durationSeconds: true, garageId: true, customerPhone: true, customerName: true, callType: true, confirmedBooking: true, summary: true, transcript: true },
  });

  console.log(`\n\n=== ${calls.length} ASSIST CALLS TODAY (2026-06-18) ===\n`);

  // Group by garage
  const byGarage = {};
  for (const c of calls) {
    if (!byGarage[c.garageId]) byGarage[c.garageId] = [];
    byGarage[c.garageId].push(c);
  }

  for (const [gid, garageCalls] of Object.entries(byGarage)) {
    const info = idToInfo[gid];
    const short = garageCalls.filter(c => c.durationSeconds && c.durationSeconds < 60);
    const normal = garageCalls.filter(c => !short.includes(c));
    console.log(`\n--- ${info.name} (${garageCalls.length} calls: ${short.length} short, ${normal.length} normal) ---`);
    for (const c of garageCalls) {
      const tlen = c.transcript ? (Array.isArray(c.transcript) ? c.transcript.length : 0) : 0;
      const firstAgentTurn = c.transcript && Array.isArray(c.transcript) ? c.transcript.find(t => t.speaker === 'assistant' || t.speaker === 'agent') : null;
      const customerTurns = c.transcript && Array.isArray(c.transcript) ? c.transcript.filter(t => t.speaker === 'user' || t.speaker === 'customer').length : 0;
      console.log(`  [${c.createdAt.toISOString().slice(11,19)}] id=${c.id} ${c.customerPhone} dur=${c.durationSeconds}s turns=${tlen} custTurns=${customerTurns} type=${c.callType} booked=${c.confirmedBooking}`);
      if (firstAgentTurn) console.log(`    1st agent: "${firstAgentTurn.text.slice(0,100)}"`);
    }
  }
}
main().catch(e=>{console.error(e);process.exit(1);}).finally(()=>prisma.$disconnect());
