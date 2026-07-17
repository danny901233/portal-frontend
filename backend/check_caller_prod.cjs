const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function gname(id) {
  const g = await prisma.garage.findUnique({ where: { id }, select: { name: true, agentConfiguration: { select: { agentScript: true } } } });
  return g ? `${g.name} (${g.agentConfiguration?.agentScript || 'no-config'})` : '(unknown)';
}

async function main() {
  const tail = '7983029350';
  const refId = '86364532';

  console.log('\n=== NORTHAMPTON REFERENCE CALL 86364532 ===\n');
  const ref = await prisma.call.findFirst({
    where: { id: { contains: refId } },
    select: { id: true, createdAt: true, durationSeconds: true, garageId: true, customerPhone: true, customerName: true, registrationNumber: true, summary: true, transcript: true, recordingDurationSeconds: true, confirmedBooking: true, callType: true },
  });
  if (ref) {
    console.log(`id=${ref.id}  ${ref.createdAt.toISOString()}`);
    console.log(`  Garage: ${await gname(ref.garageId)}`);
    console.log(`  Duration: ${ref.durationSeconds}s | RecDur: ${ref.recordingDurationSeconds}s | Phone: ${ref.customerPhone}`);
    console.log(`  Name: ${ref.customerName} | Reg: ${ref.registrationNumber} | Booked: ${ref.confirmedBooking} | Type: ${ref.callType}`);
    console.log(`  Summary: ${(ref.summary||'').slice(0,500)}`);
    const t = ref.transcript ? JSON.stringify(ref.transcript).slice(0,2000) : '(none)';
    console.log(`  Transcript[0:2000]: ${t}`);
  } else {
    console.log('(not found)');
  }

  console.log(`\n\n=== CALLER ...${tail} ALL-TIME HISTORY ===\n`);
  const calls = await prisma.call.findMany({
    where: { customerPhone: { contains: tail } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, createdAt: true, durationSeconds: true, recordingDurationSeconds: true, garageId: true, customerPhone: true, customerName: true, registrationNumber: true, confirmedBooking: true, callType: true, summary: true, transcript: true },
  });
  console.log(`Found ${calls.length} calls.\n`);
  for (const c of calls) {
    console.log(`[${c.createdAt.toISOString()}] id=${c.id} ${await gname(c.garageId)} dur=${c.durationSeconds}s rec=${c.recordingDurationSeconds}s type=${c.callType} booked=${c.confirmedBooking}`);
    console.log(`  Name=${c.customerName} Reg=${c.registrationNumber}`);
    if (c.summary) console.log(`  Sum: ${c.summary.slice(0,250)}`);
    if (c.transcript) console.log(`  T: ${JSON.stringify(c.transcript).slice(0,500)}`);
    console.log('');
  }
}
main().catch(e=>{console.error(e);process.exit(1);}).finally(()=>prisma.$disconnect());
