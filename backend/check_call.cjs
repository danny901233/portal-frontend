const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const callId = '32189816';
  const c = await prisma.call.findFirst({
    where: { id: { contains: callId } },
    select: { id: true, createdAt: true, garageId: true, customerPhone: true, customerName: true, registrationNumber: true, durationSeconds: true, callType: true, confirmedBooking: true, summary: true, transcript: true },
  });
  if (!c) { console.log('(call not found)'); return; }

  const g = await prisma.garage.findUnique({
    where: { id: c.garageId },
    select: {
      name: true,
      agentConfiguration: {
        select: { agentScript: true, agentType: true, allowBookings: true, bookingLeadTimeDays: true, voice: true, greetingLine: true, integrationProvider: true },
      },
    },
  });

  console.log(`\n=== Call ${c.id} ===`);
  console.log(`Time: ${c.createdAt.toISOString()}`);
  console.log(`Garage: ${g?.name}`);
  console.log(`agentScript: ${g?.agentConfiguration?.agentScript}`);
  console.log(`agentType: ${g?.agentConfiguration?.agentType}`);
  console.log(`allowBookings: ${g?.agentConfiguration?.allowBookings}`);
  console.log(`bookingLeadTimeDays: ${g?.agentConfiguration?.bookingLeadTimeDays}`);
  console.log(`integrationProvider: ${g?.agentConfiguration?.integrationProvider}`);
  console.log(`voice: ${g?.agentConfiguration?.voice}`);
  console.log(`greetingLine: "${g?.agentConfiguration?.greetingLine}"`);
  console.log('');
  console.log(`Duration: ${c.durationSeconds}s | callType: ${c.callType} | confirmedBooking: ${c.confirmedBooking}`);
  console.log(`Customer: ${c.customerName} | Phone: ${c.customerPhone} | Reg: ${c.registrationNumber}`);
  console.log(`Summary: ${(c.summary||'').slice(0, 400)}`);
  console.log('');
  if (Array.isArray(c.transcript)) {
    console.log(`Transcript (${c.transcript.length} turns):`);
    for (const t of c.transcript) {
      console.log(`  [${t.timestamp?.toFixed?.(2) ?? '?'}] ${t.speaker || t.role}: ${(t.text||'').slice(0, 200)}`);
    }
  }
}
main().catch(e=>{console.error(e);process.exit(1);}).finally(()=>prisma.$disconnect());
