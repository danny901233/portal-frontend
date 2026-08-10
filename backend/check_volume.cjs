const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // Most recent 10 calls regardless of date
  const recent = await prisma.call.findMany({
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: { id: true, createdAt: true, garageId: true, durationSeconds: true },
  });
  console.log('\n=== MOST RECENT 10 CALLS (any date) ===\n');
  for (const c of recent) {
    const g = await prisma.garage.findUnique({ where: { id: c.garageId }, select: { name: true } });
    console.log(`[${c.createdAt.toISOString()}] id=${c.id} ${g?.name} dur=${c.durationSeconds}s`);
  }

  // Counts per hour today
  console.log('\n=== CALL COUNT PER HOUR TODAY (2026-06-19) ===\n');
  const dayStart = new Date('2026-06-19T00:00:00Z');
  const todayCalls = await prisma.call.findMany({
    where: { createdAt: { gte: dayStart } },
    select: { createdAt: true },
  });
  const byHour = {};
  for (const c of todayCalls) {
    const h = c.createdAt.toISOString().slice(11, 13);
    byHour[h] = (byHour[h] || 0) + 1;
  }
  for (const h of Object.keys(byHour).sort()) {
    console.log(`${h}:00 UTC | ${byHour[h]}`);
  }

  // Now in UTC
  console.log('\n=== SYSTEM TIME ===');
  console.log(`Now (server time): ${new Date().toISOString()}`);
}
main().catch(e=>{console.error(e);process.exit(1);}).finally(()=>prisma.$disconnect());
