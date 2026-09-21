// Teach Elite Autocare's agent how wheel alignment pricing works.
//
//   node scripts/set-elite-alignment-rule.cjs          # dry run
//   node scripts/set-elite-alignment-rule.cjs --apply
//
// Elite's alignment is sold as a £20 diagnostic first, which is then REPLACED by the adjustment
// cost if work is needed. Without this the agent knows only the £20 WAD price and would quote
// that as the whole job — so a caller needing front-and-rear toe would be told £20 and billed
// £79.98. Custom rules override the general guidance, which is what this needs.
require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env') });
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

const RULE = [
  'WHEEL ALIGNMENT / TRACKING — how the pricing works, explain it in this order:',
  '1. Always start with the diagnostic. "We start with a full alignment diagnostic for £20 — that checks all the angles on your wheels against the manufacturer\'s specification."',
  '2. If nothing needs adjusting, the £20 is all they pay. Say so, it reassures them.',
  '3. If an adjustment IS needed, the £20 diagnostic charge is REMOVED and replaced by the alignment cost — it is not added on top. Front toe adjustment is £48. Front and rear toe is £79.98.',
  '4. Further adjustments such as camber or caster are £23.95 each.',
  '5. Some vehicles need more specialised work — subframe shifts, axle adjustments, camber bolts or shims. Not every car needs these, so only ever say they would be advised AFTER the diagnostic. Never quote for them.',
  '6. Close by booking the diagnostic: "The best place to start is the £20 diagnostic, then we can talk you through exactly what your car needs. Would you like me to get that booked in?"',
  'Book alignment enquiries as Wheel Alignment Diagnostics (WAD) — that is the £20 diagnostic, and it is what the caller is committing to. Do not quote the adjustment prices as though they were the price of the job.',
].join('\n');

async function main() {
  const g = await prisma.garage.findFirst({ where: { name: 'Elite Autocare' }, select: { id: true } });
  const cfg = await prisma.agentConfiguration.findUnique({
    where: { garageId: g.id }, select: { customRules: true },
  });
  const existing = Array.isArray(cfg.customRules) ? cfg.customRules : [];
  console.log('existing rules:', existing.length);
  const next = [...existing.filter((r) => !String(r?.text || '').startsWith('WHEEL ALIGNMENT')),
                { text: RULE, active: true }];
  console.log('\n--- rule to be stored ---\n' + RULE);
  if (!APPLY) return console.log('\nDry run — nothing written. Re-run with --apply.');
  await prisma.agentConfiguration.update({ where: { garageId: g.id }, data: { customRules: next } });
  const { sendAgentConfigWebhook } = await import('../dist/routes/config.js');
  await sendAgentConfigWebhook(g.id);
  console.log('\nStored and synced. Total rules now:', next.length);
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
