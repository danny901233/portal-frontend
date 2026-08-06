const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const tail = '7983029350';
  const northamptonCallId = '86364532';

  console.log('\n=== NORTHAMPTON REFERENCE CALL (working during incident) ===\n');
  const ref = await prisma.call.findFirst({
    where: { id: { contains: northamptonCallId } },
    select: {
      id: true, createdAt: true, durationSeconds: true, callStatus: true,
      garageId: true, customerPhone: true, callSummary: true, callTranscript: true,
    },
  });
  if (ref) {
    const g = await prisma.garage.findUnique({ where: { id: ref.garageId }, select: { name: true, agentScript: true } });
    console.log(`id=${ref.id}  [${ref.createdAt.toISOString()}]`);
    console.log(`  Garage: ${g?.name} (${g?.agentScript})`);
    console.log(`  Duration: ${ref.durationSeconds}s | Status: ${ref.callStatus}`);
    console.log(`  Phone: ${ref.customerPhone}`);
    console.log(`  Summary: ${ref.callSummary?.slice(0, 300)}`);
    console.log(`  Transcript[0:600]: ${(ref.callTranscript||'').slice(0, 600).replace(/\n/g, ' | ')}`);
  } else {
    console.log(`(no call found with id containing ${northamptonCallId})`);
  }

  console.log(`\n\n=== CALLER ...${tail} HISTORY (all-time, all garages) ===\n`);
  const calls = await prisma.call.findMany({
    where: { customerPhone: { contains: tail } },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, createdAt: true, durationSeconds: true, callStatus: true,
      garageId: true, customerPhone: true, callSummary: true, callTranscript: true,
    },
  });

  console.log(`Found ${calls.length} calls.\n`);
  for (const c of calls) {
    const g = await prisma.garage.findUnique({ where: { id: c.garageId }, select: { name: true, agentScript: true } });
    console.log(`[${c.createdAt.toISOString()}] id=${c.id}  ${g?.name} (${g?.agentScript})  dur=${c.durationSeconds}s  status=${c.callStatus}`);
    if (c.callSummary) console.log(`  Summary: ${c.callSummary.slice(0, 200)}`);
    if (c.callTranscript) console.log(`  T[0:300]: ${(c.callTranscript||'').slice(0, 300).replace(/\n/g, ' | ')}`);
    console.log('');
  }
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
