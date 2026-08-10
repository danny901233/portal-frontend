const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

function agentTurn(t) { return t.speaker === 'assistant' || t.speaker === 'agent'; }
function userTurn(t) { return t.speaker === 'user' || t.speaker === 'customer'; }

function analyzeTranscript(transcript) {
  if (!Array.isArray(transcript) || !transcript.length) {
    return { agentTurns: 0, userTurns: 0, firstAgentTs: null, firstUserTs: null, userBeforeAgent: false, callStartTs: null };
  }
  let firstAgentTs = null, firstUserTs = null, agentTurns = 0, userTurns = 0;
  const callStartTs = transcript[0]?.timestamp ?? null;
  for (const t of transcript) {
    if (agentTurn(t)) { agentTurns++; if (firstAgentTs === null) firstAgentTs = t.timestamp; }
    if (userTurn(t)) { userTurns++; if (firstUserTs === null) firstUserTs = t.timestamp; }
  }
  const userBeforeAgent = !!(firstUserTs && firstAgentTs && firstUserTs < firstAgentTs);
  return { agentTurns, userTurns, firstAgentTs, firstUserTs, userBeforeAgent, callStartTs };
}

function dayKey(d) { return d.toISOString().slice(0,10); }

async function main() {
  const since = new Date(Date.now() - 7*24*60*60*1000); // last 7 days
  const calls = await prisma.call.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, createdAt: true, garageId: true, customerPhone: true, durationSeconds: true, transcript: true },
  });
  console.log(`Total calls last 7d: ${calls.length}`);

  // Gather garage info
  const garageIds = [...new Set(calls.map(c => c.garageId))];
  const garages = await prisma.garage.findMany({
    where: { id: { in: garageIds } },
    select: { id: true, name: true, agentConfiguration: { select: { agentScript: true, greetingLine: true } } },
  });
  const gmap = Object.fromEntries(garages.map(g => [g.id, g]));

  // Per-day rollup
  const byDay = {};
  for (const c of calls) {
    const day = dayKey(c.createdAt);
    if (!byDay[day]) byDay[day] = { total: 0, short_zero_user: 0, user_before_agent: 0, total_agent_delay_s: 0, calls_with_both: 0 };
    const b = byDay[day];
    b.total++;
    const a = analyzeTranscript(c.transcript);
    if ((c.durationSeconds ?? 0) < 60 && a.userTurns === 0) b.short_zero_user++;
    if (a.userBeforeAgent) b.user_before_agent++;
    if (a.firstAgentTs && a.callStartTs !== null) {
      b.total_agent_delay_s += (a.firstAgentTs - a.callStartTs);
      b.calls_with_both++;
    }
  }

  console.log('\n=== PER-DAY ROLLUP (last 7d, all garages) ===\n');
  console.log('day        | total | shortHangup | shortRate | userFirst | userFirstRate | avgAgentDelay');
  console.log('-----------|-------|-------------|-----------|-----------|---------------|--------------');
  const days = Object.keys(byDay).sort();
  for (const d of days) {
    const b = byDay[d];
    const sr = (b.short_zero_user / b.total * 100).toFixed(1);
    const ur = (b.user_before_agent / b.total * 100).toFixed(1);
    const ad = b.calls_with_both ? (b.total_agent_delay_s / b.calls_with_both).toFixed(2) : 'n/a';
    console.log(`${d} | ${String(b.total).padStart(5)} | ${String(b.short_zero_user).padStart(11)} | ${sr.padStart(7)}% | ${String(b.user_before_agent).padStart(9)} | ${ur.padStart(11)}% | ${String(ad).padStart(11)}s`);
  }

  // Per-garage today vs baseline
  console.log('\n=== PER-GARAGE TODAY (2026-06-18) vs 7d BASELINE (excl today) ===\n');
  const today = '2026-06-18';
  const perGarage = {};
  for (const c of calls) {
    const day = dayKey(c.createdAt);
    const gid = c.garageId;
    if (!perGarage[gid]) perGarage[gid] = { today: { n:0, s:0, u:0 }, baseline: { n:0, s:0, u:0 } };
    const bucket = day === today ? perGarage[gid].today : perGarage[gid].baseline;
    bucket.n++;
    const a = analyzeTranscript(c.transcript);
    if ((c.durationSeconds ?? 0) < 60 && a.userTurns === 0) bucket.s++;
    if (a.userBeforeAgent) bucket.u++;
  }

  const rows = [];
  for (const [gid, p] of Object.entries(perGarage)) {
    if (p.today.n === 0 || p.baseline.n < 3) continue;
    const tSr = (p.today.s / p.today.n * 100);
    const bSr = (p.baseline.s / p.baseline.n * 100);
    const tUr = (p.today.u / p.today.n * 100);
    const bUr = (p.baseline.u / p.baseline.n * 100);
    rows.push({ name: gmap[gid]?.name || gid, script: gmap[gid]?.agentConfiguration?.agentScript || '?', tN: p.today.n, bN: p.baseline.n, tSr, bSr, tUr, bUr, delta: tSr - bSr });
  }
  rows.sort((a,b) => b.delta - a.delta);
  console.log('garage                                 | script        | todayN | baseN | todayShort | baseShort | DELTA   | todayUserFirst | baseUserFirst');
  console.log('---------------------------------------|---------------|--------|-------|------------|-----------|---------|----------------|-------------');
  for (const r of rows.slice(0, 30)) {
    console.log(`${r.name.padEnd(38)} | ${r.script.padEnd(13)} | ${String(r.tN).padStart(6)} | ${String(r.bN).padStart(5)} | ${(r.tSr.toFixed(1)+'%').padStart(10)} | ${(r.bSr.toFixed(1)+'%').padStart(9)} | ${(r.delta>=0?'+':'')+r.delta.toFixed(1)+'%' .padStart(7)} | ${(r.tUr.toFixed(1)+'%').padStart(14)} | ${(r.bUr.toFixed(1)+'%').padStart(11)}`);
  }
}
main().catch(e=>{console.error(e);process.exit(1);}).finally(()=>prisma.$disconnect());
