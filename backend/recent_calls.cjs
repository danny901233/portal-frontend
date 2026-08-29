const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

(async () => {
  const rows = await p.$queryRawUnsafe(`
    WITH recent AS (
      SELECT c.id, g.name AS garage,
             c."createdAt", c."callType", c."confirmedBooking",
             c."customerName", c."registrationNumber" AS reg,
             c."durationSeconds",
             LEFT(COALESCE(c.summary,''), 300) AS summary,
             ROW_NUMBER() OVER (PARTITION BY g.name ORDER BY c."createdAt" DESC) AS rn
      FROM "Call" c
      JOIN "Garage" g ON g.id = c."garageId"
      JOIN "AgentConfiguration" ac ON ac."garageId" = c."garageId"
      WHERE c."createdAt" >= NOW() - INTERVAL '48 hours'
    ),
    withfb AS (
      SELECT r.*, cf.rating AS feedback, cf.notes AS fb_notes
      FROM recent r
      LEFT JOIN "CallFeedback" cf ON cf."callId" = r.id
      WHERE r.rn <= 2
    )
    SELECT * FROM withfb
    ORDER BY garage, rn
  `);

  const byGarage = {};
  rows.forEach(r => {
    (byGarage[r.garage] ||= []).push(r);
  });

  Object.keys(byGarage).sort().forEach(garage => {
    console.log(`\n=== ${garage} ===`);
    byGarage[garage].forEach(r => {
      const dt = new Date(r.createdAt).toISOString().replace('T',' ').slice(0,19);
      const dur = r.durationSeconds ? `${r.durationSeconds}s` : '-';
      const booked = r.confirmedBooking === true ? '✓BOOKED' : '';
      const fb = r.feedback ? ` [FEEDBACK:${r.feedback}]` : '';
      console.log(`  ${r.id} | ${dt} | ${dur} | ${r.callType || '-'} | ${r.customerName || '-'} | reg=${r.reg || '-'} ${booked}${fb}`);
      console.log(`    ${r.summary || '(no summary)'}`);
      if (r.fb_notes) console.log(`    FB_NOTES: ${r.fb_notes}`);
    });
  });
  await p.$disconnect();
})().catch(e => { console.error(e.message); process.exit(1); });
