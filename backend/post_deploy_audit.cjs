const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

function agentTurn(t) { return t.speaker === 'assistant' || t.speaker === 'agent'; }
function userTurn(t) { return t.speaker === 'user' || t.speaker === 'customer'; }

async function main() {
  const deployTime = new Date('2026-06-19T06:59:16Z');
  const dayStart = new Date('2026-06-19T00:00:00Z');

  const calls = await prisma.call.findMany({
    where: { createdAt: { gte: dayStart } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, createdAt: true, garageId: true, customerPhone: true, durationSeconds: true, transcript: true, callType: true, confirmedBooking: true },
  });

  // Get garage info for all garages today
  const garageIds = [...new Set(calls.map(c => c.garageId))];
  const garages = await prisma.garage.findMany({
    where: { id: { in: garageIds } },
    select: { id: true, name: true, agentConfiguration: { select: { agentScript: true } } },
  });
  const gmap = Object.fromEntries(garages.map(g => [g.id, g]));

  // Bucket: pre-deploy, post-deploy today; per-agent
  const buckets = {
    'Assist (pre 06:59Z)': { n: 0, s: 0 },
    'Assist (post 06:59Z)': { n: 0, s: 0 },
    'GarageHive (all today)': { n: 0, s: 0 },
    'Other (all today)': { n: 0, s: 0 },
  };

  // Per-garage post-deploy short-hangup
  const perGaragePost = {};

  for (const c of calls) {
    const g = gmap[c.garageId];
    const script = g?.agentConfiguration?.agentScript || 'unknown';
    const isAssist = script === 'Assist-agent' || script === 'receptionmate-agent';
    const isGH = script === 'GarageHive-agent';
    const isPostDeploy = c.createdAt >= deployTime;

    let bucket = 'Other (all today)';
    if (isAssist && !isPostDeploy) bucket = 'Assist (pre 06:59Z)';
    else if (isAssist && isPostDeploy) bucket = 'Assist (post 06:59Z)';
    else if (isGH) bucket = 'GarageHive (all today)';

    const userTurns = Array.isArray(c.transcript) ? c.transcript.filter(userTurn).length : 0;
    const isShort = (c.durationSeconds ?? 0) < 60 && userTurns === 0;

    buckets[bucket].n++;
    if (isShort) buckets[bucket].s++;

    if (isAssist && isPostDeploy) {
      const k = g?.name || c.garageId;
      if (!perGaragePost[k]) perGaragePost[k] = { n: 0, s: 0 };
      perGaragePost[k].n++;
      if (isShort) perGaragePost[k].s++;
    }
  }

  console.log('\n=== 2026-06-19 SHORT-HANGUP RATES ===');
  console.log('(short-hangup = dur<60s AND 0 customer turns)\n');
  console.log('bucket                       | calls | short | rate');
  console.log('-----------------------------|-------|-------|--------');
  for (const [name, b] of Object.entries(buckets)) {
    const r = b.n ? ((b.s/b.n)*100).toFixed(1) : '-';
    console.log(`${name.padEnd(28)} | ${String(b.n).padStart(5)} | ${String(b.s).padStart(5)} | ${(r+'%').padStart(6)}`);
  }

  console.log('\n=== Per-Assist-garage POST-DEPLOY (06:59Z onwards) ===\n');
  console.log('garage                                 | calls | short | rate');
  console.log('---------------------------------------|-------|-------|--------');
  const sorted = Object.entries(perGaragePost).sort((a,b) => b[1].n - a[1].n);
  for (const [name, b] of sorted) {
    const r = b.n ? ((b.s/b.n)*100).toFixed(1) : '-';
    console.log(`${name.padEnd(38)} | ${String(b.n).padStart(5)} | ${String(b.s).padStart(5)} | ${(r+'%').padStart(6)}`);
  }
}
main().catch(e=>{console.error(e);process.exit(1);}).finally(()=>prisma.$disconnect());
