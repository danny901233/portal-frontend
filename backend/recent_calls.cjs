const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

function userTurn(t) { return t.speaker === 'user' || t.speaker === 'customer'; }

async function main() {
  const deployTime = new Date('2026-06-19T06:59:16Z');
  const calls = await prisma.call.findMany({
    where: { createdAt: { gte: deployTime } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, createdAt: true, garageId: true, customerPhone: true, durationSeconds: true, transcript: true, callType: true, confirmedBooking: true },
  });

  const gids = [...new Set(calls.map(c => c.garageId))];
  const garages = await prisma.garage.findMany({
    where: { id: { in: gids } },
    select: { id: true, name: true, agentConfiguration: { select: { agentScript: true } } },
  });
  const gmap = Object.fromEntries(garages.map(g => [g.id, g]));

  console.log(`\nServer time now: ${new Date().toISOString()}`);
  console.log(`Deploy time:    ${deployTime.toISOString()}`);
  console.log(`Window so far:  ${Math.round((Date.now() - deployTime.getTime()) / 1000 / 60)} min\n`);
  console.log(`=== POST-DEPLOY CALLS (${calls.length}) ===\n`);
  console.log('time   | garage                          | script        | dur | userTurns | flag');
  console.log('-------|--------------------------------|---------------|-----|-----------|------');
  let assistN=0, assistS=0, ghN=0, ghS=0;
  for (const c of calls) {
    const g = gmap[c.garageId];
    const script = g?.agentConfiguration?.agentScript || '?';
    const userTurns = Array.isArray(c.transcript) ? c.transcript.filter(userTurn).length : 0;
    const isShort = (c.durationSeconds ?? 0) < 60 && userTurns === 0;
    const flag = isShort ? '⚠ SHORT' : '✓';
    const isAssist = script === 'Assist-agent' || script === 'receptionmate-agent';
    const isGH = script === 'GarageHive-agent';
    if (isAssist) { assistN++; if (isShort) assistS++; }
    if (isGH) { ghN++; if (isShort) ghS++; }
    const t = c.createdAt.toISOString().slice(11, 16);
    console.log(`${t} | ${(g?.name||'?').padEnd(31)} | ${script.padEnd(13)} | ${String(c.durationSeconds).padStart(3)}s | ${String(userTurns).padStart(9)} | ${flag}`);
  }
  console.log(`\nAssist (new V1+static): ${assistS}/${assistN} short = ${assistN ? ((assistS/assistN)*100).toFixed(1)+'%' : '-'}`);
  console.log(`GarageHive (still V1+dynamic): ${ghS}/${ghN} short = ${ghN ? ((ghS/ghN)*100).toFixed(1)+'%' : '-'}`);
}
main().catch(e=>{console.error(e);process.exit(1);}).finally(()=>prisma.$disconnect());
