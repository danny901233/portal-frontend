const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function gname(id) {
  const g = await prisma.garage.findUnique({ where: { id }, select: { name: true, agentConfiguration: { select: { agentScript: true, greetingLine: true } } } });
  return g ? `${g.name} (${g.agentConfiguration?.agentScript})` : '(unknown)';
}

async function main() {
  // 1. Find call by roomName containing the LK session ID hint
  console.log('\n=== SEARCH BY ROOM NAME (recent GH calls) ===');
  const recent = await prisma.call.findMany({
    where: {
      createdAt: { gte: new Date('2026-06-18T11:00:00Z') },
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, createdAt: true, garageId: true, customerPhone: true, durationSeconds: true, callType: true, transcript: true, roomName: true },
  });

  // Filter to GH garages + Northampton + look at first-agent timing
  console.log(`Total today (since 11:00): ${recent.length}`);

  const targetGarages = ['Norwich','Erith','Spalding','Basingstoke','Telford','Northampton','Promotive','C&G','RPM','Falmouth','VGS','Boam','Regal','St Johns','ADS'];

  for (const c of recent) {
    const g = await prisma.garage.findUnique({ where: { id: c.garageId }, select: { name: true, agentConfiguration: { select: { agentScript: true, greetingLine: true } } } });
    if (!g) continue;
    if (!targetGarages.some(t => g.name.toLowerCase().includes(t.toLowerCase()))) continue;
    if (g.agentConfiguration?.agentScript !== 'GarageHive-agent' && g.agentConfiguration?.agentScript !== 'Assist-agent') continue;

    // analyze transcript for first agent turn timing
    let firstAgentTs = null, firstUserTs = null, callStartTs = null, agentFirstText = '';
    if (c.transcript && Array.isArray(c.transcript)) {
      for (const t of c.transcript) {
        const ts = t.timestamp;
        if (callStartTs === null) callStartTs = ts;
        if ((t.speaker === 'assistant' || t.speaker === 'agent') && firstAgentTs === null) {
          firstAgentTs = ts;
          agentFirstText = (t.text || '').slice(0, 80);
        }
        if ((t.speaker === 'user' || t.speaker === 'customer') && firstUserTs === null) {
          firstUserTs = ts;
        }
      }
    }
    const userBeforeAgent = (firstUserTs && firstAgentTs && firstUserTs < firstAgentTs);
    const agentDelay = firstAgentTs && callStartTs ? (firstAgentTs - callStartTs).toFixed(2) : '?';

    console.log(`[${c.createdAt.toISOString().slice(11,19)}] id=${c.id} ${g.name} (${g.agentConfiguration?.agentScript}) dur=${c.durationSeconds}s`);
    console.log(`  room=${c.roomName || '(none)'}`);
    console.log(`  agentDelaySec=${agentDelay} userBeforeAgent=${userBeforeAgent}`);
    console.log(`  configured greeting: "${(g.agentConfiguration?.greetingLine||'').slice(0,80)}"`);
    console.log(`  agent first turn: "${agentFirstText}"`);
    console.log('');
  }
}
main().catch(e=>{console.error(e);process.exit(1);}).finally(()=>prisma.$disconnect());
