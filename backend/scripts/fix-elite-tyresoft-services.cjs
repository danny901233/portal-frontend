// Rewrite Elite Autocare's Tyresoft service catalogue to match what Tyresoft actually has.
//
//   node scripts/fix-elite-tyresoft-services.cjs          # dry run
//   node scripts/fix-elite-tyresoft-services.cjs --apply
//
// Three services were configured that do not exist at Tyresoft (WA, AIRCON, PUNC). They had
// prices but no tsServiceId, so the agent quoted them, added them to the job, and then failed
// on availability with HTTP 400 "Can not construct instance of java.lang.Long from 'WA'".
// Eight real services were missing entirely, including WAD — Wheel Alignment Diagnostics —
// which is the "tracking check" callers actually ask for.
//
// Prices are VAT-INCLUSIVE. Tyresoft's export gives ex-VAT sell prices and the agent is told
// never to add VAT ("never round, estimate or add VAT"), so the stored figure is what the
// caller is quoted. TPMS was stored at 65 and quoted at 65 against a real 78.
require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env') });
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

// name, code, tsServiceId, ex-VAT export price, VAT code (S standard / E exempt)
const TYRESOFT = [
  ['Full Service',                                   'FS',           65,  null, 'S', 'engine-size'],
  ['Interim Service',                                'INTS',         66,  null, 'S', 'engine-size'],
  ['Oil and Filter Change',                          'OIL',          67,  null, 'S', 'engine-size'],
  ['MOT',                                            'MOT',          68,  54.00, 'E', 'fixed'],
  ['MOT (when a service is booked too)',             'MOT2',        385,  39.99, 'S', 'fixed'],
  ['Wheel Alignment Diagnostics',                    'WAD',          60,  16.67, 'S', 'fixed'],
  ['ADAS Diagnostics Check',                         'adas',        604,  40.00, 'S', 'fixed'],
  ['Diagnostic Assessment',                          'DIAG',        138, 120.00, 'S', 'fixed'],
  ['Supply and Fit TPMS Sensor',                     'TPMS',         64,  65.00, 'S', 'fixed'],
  ['TPMS Diagnostic',                                'TPMSDIAG',     63,  25.00, 'S', 'fixed'],
  ['Wheel Refurbishment (up to 18 inch)',            'WHEELREFURB1',186,  66.67, 'S', 'fixed'],
  ['Wheel Refurbishment (19 inch and above)',        'WHEELREFURB2',185,  83.33, 'S', 'fixed'],
  ['Wheel Straightening',                            'WST',         673,  50.00, 'S', 'fixed'],
  ['MISC - Misc Online',                             'MISC',        723,  0,     'S', 'fixed'],
];

const incVat = (net, code) => code === 'E' ? net : Math.round(net * 1.2 * 100) / 100;

async function main() {
  const g = await prisma.garage.findFirst({ where: { name: 'Elite Autocare' }, select: { id: true } });
  if (!g) throw new Error('Elite Autocare not found');
  const cfg = await prisma.agentConfiguration.findUnique({
    where: { garageId: g.id }, select: { integrationProviderConfig: true },
  });
  const ipc = { ...(cfg.integrationProviderConfig || {}) };
  const before = ipc.tsServices || [];

  const after = TYRESOFT.map(([name, code, id, net, vat, pricing]) => {
    const row = { id: code, name, tsServiceId: id, pricingType: pricing };
    if (pricing === 'fixed') row.price = incVat(net, vat);
    return row;
  });

  console.log('BEFORE:');
  for (const s of before) console.log(`   ${String(s.id).padEnd(14)} id=${String(s.tsServiceId ?? '** MISSING **').padEnd(13)} £${s.price ?? '(engine size)'}  ${s.name}`);
  console.log('\nAFTER:');
  for (const s of after) console.log(`   ${String(s.id).padEnd(14)} id=${String(s.tsServiceId).padEnd(13)} £${s.price ?? '(engine size)'}  ${s.name}`);

  const removed = before.filter((b) => !after.some((a) => a.id === b.id)).map((b) => b.id);
  const added = after.filter((a) => !before.some((b) => b.id === a.id)).map((a) => a.id);
  const repriced = after.filter((a) => { const b = before.find((x) => x.id === a.id); return b && b.price != null && a.price != null && b.price !== a.price; });
  console.log(`\nremoved (not real Tyresoft services): ${removed.join(', ') || 'none'}`);
  console.log(`added:                                ${added.join(', ') || 'none'}`);
  console.log(`repriced to VAT-inclusive:            ${repriced.map((r) => `${r.id} -> £${r.price}`).join(', ') || 'none'}`);

  if (!APPLY) return console.log('\nDry run — nothing written. Re-run with --apply.');
  ipc.tsServices = after;
  await prisma.agentConfiguration.update({ where: { garageId: g.id }, data: { integrationProviderConfig: ipc } });
  const { sendAgentConfigWebhook } = await import('../dist/routes/config.js');
  await sendAgentConfigWebhook(g.id);
  console.log('\nWritten and synced to the agent.');
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
