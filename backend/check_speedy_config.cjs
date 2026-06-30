const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const speedy = await prisma.garage.findFirst({
    where: { name: { contains: 'Speedy', mode: 'insensitive' } },
    select: { id: true, name: true, twilioNumber: true, agentConfiguration: true },
  });

  console.log('\n=== SPEEDY SPANNERS — FULL AGENT CONFIGURATION ===\n');
  console.log(`garage.id = ${speedy.id}`);
  console.log(`garage.name = ${speedy.name}`);
  console.log(`garage.twilioNumber = ${speedy.twilioNumber}`);
  console.log('');

  const c = speedy.agentConfiguration;
  if (!c) { console.log('(NO agentConfiguration row)'); return; }

  // Print every field, value, length
  for (const [k, v] of Object.entries(c)) {
    if (v === null || v === undefined) { console.log(`${k}: null`); continue; }
    if (typeof v === 'string') {
      console.log(`${k} (string, len=${v.length}):`);
      console.log(`  "${v.slice(0, 800)}"${v.length > 800 ? '...[truncated]' : ''}`);
    } else if (typeof v === 'object') {
      const j = JSON.stringify(v);
      console.log(`${k} (object, len=${j.length}):`);
      console.log(`  ${j.slice(0, 1200)}${j.length > 1200 ? '...[truncated]' : ''}`);
    } else {
      console.log(`${k}: ${v}`);
    }
    console.log('');
  }

  console.log('\n\n=== NORTHAMPTON GARAGE — FULL AGENT CONFIGURATION (compare) ===\n');
  const np = await prisma.garage.findFirst({
    where: { name: { contains: 'Northampton', mode: 'insensitive' } },
    select: { id: true, name: true, agentConfiguration: true },
  });
  if (np?.agentConfiguration) {
    for (const [k, v] of Object.entries(np.agentConfiguration)) {
      if (v === null || v === undefined) { console.log(`${k}: null`); continue; }
      if (typeof v === 'string') {
        console.log(`${k} (string, len=${v.length}):`);
        console.log(`  "${v.slice(0, 800)}"${v.length > 800 ? '...[truncated]' : ''}`);
      } else if (typeof v === 'object') {
        const j = JSON.stringify(v);
        console.log(`${k} (object, len=${j.length}):`);
        console.log(`  ${j.slice(0, 1200)}${j.length > 1200 ? '...[truncated]' : ''}`);
      } else {
        console.log(`${k}: ${v}`);
      }
      console.log('');
    }
  }
}
main().catch(e=>{console.error(e);process.exit(1);}).finally(()=>prisma.$disconnect());
