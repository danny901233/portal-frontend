/**
 * Tyres AND an MOT on one visit, end to end against the Tyresoft TEST account.
 *
 * The claim is that a Tyresoft customer can have both on a single job. This proves it by
 * building the job, committing it, and reading back what actually went on the sale — the
 * two failure modes being a tyre-only sale that silently drops the MOT, and a service line
 * counted twice because it sits on both the basket and the chosen list.
 */

import { PrismaClient } from '@prisma/client';
import { TyresoftChatDiary } from '../tyresoft.js';

const prisma = new PrismaClient();
const GARAGE = 'a72e3f2f-dc68-42d8-b4b0-9d9eea48cc1b';   // 🔵 Test — Tyresoft
const REG = 'V20ALA';

async function main() {
  const rows: any[] = await prisma.$queryRawUnsafe(
    `SELECT g.name, a."integrationProviderConfig" AS cfg
     FROM "Garage" g JOIN "AgentConfiguration" a ON a."garageId"=g.id WHERE g.id=$1`, GARAGE);
  const row = rows[0];
  if (!/test/i.test(String(row?.name))) throw new Error(`REFUSING: ${row?.name} is not a test garage`);
  const cfg = row.cfg as any;

  // A small stub stock feed, so the test does not depend on a CSV being present.
  const inventory = [{
    stock_number: 'TEST-235-60-18', title: '235/60R18 107V TEST PREMIUM', brand: 'MICHELIN',
    price: 89.17, width: '235', aspect_ratio: '60', rim: '18', lead_time_days: 0,
  }];

  const d = new TyresoftChatDiary(cfg, inventory);
  console.log(`  diary enabled: ${d.enabled}`);

  const vehicle = await d.lookupVehicle(REG);
  console.log(`  vehicle: ${vehicle?.description} — sizes on record: ${vehicle?.tyreSizes?.join(', ') || 'none'}`);

  const tyres = await d.searchTyres('235/60 R18', { quality: 'premium', position: 'front pair' });
  console.log(`  tyres found: ${tyres.length}`);
  if (!tyres.length) throw new Error('no tyres — cannot test the combined job');
  await d.addTyre(tyres[0], 2);

  const services = await d.offerServices(REG);
  const mot = services.find((s) => /mot/i.test(s.name));
  console.log(`  services: ${services.length}, MOT found: ${mot ? mot.name : 'NO MOT CONFIGURED'}`);
  if (!mot) throw new Error('this garage lists no MOT — cannot test the combined job');
  await d.addServiceLine(mot.key);

  const lines = d.basketLines();
  console.log('  job now holds:');
  for (const l of lines) console.log(`    ${l.kind.padEnd(7)} ${l.quantity} x ${l.description} @ £${l.unitPrice}`);
  const tyreLines = lines.filter((l) => l.kind === 'tyre').length;
  const svcLines = lines.filter((l) => l.kind === 'service').length;
  if (tyreLines !== 1 || svcLines !== 1) {
    throw new Error(`expected one tyre line and one service line, got ${tyreLines}/${svcLines}`);
  }

  const slots = await d.offerSlots([mot.key]);
  console.log(`  availability for the whole job: ${slots.length} slots`);
  if (!slots.length) throw new Error('no slots for the combined job');

  const booking = await d.confirm(slots[0].key, {
    name: 'Harness Combined', phone: '07976500282', email: 'harness@example.com',
    address: '55 Test Road', postcode: 'CB23 9AZ', city: 'Rugby', mileage: '25000',
    notes: 'automated tyres+MOT check — safe to delete',
  });

  console.log(`\n  BOOKED ${booking.reference} for ${booking.whenIso}`);
  console.log(`  the sale describes: ${booking.serviceName}`);

  const sale: any = booking.raw;
  const items: any[] = sale?.items || [];
  const tyreItems = items.filter((i) => i.productItem === true || i.itemCode);
  const svcItems = items.filter((i) => Number(i.serviceID) > 0);
  console.log(`  sale lines: ${items.length} (${tyreItems.length} tyre, ${svcItems.length} service)`);

  const said = String(booking.serviceName || '');
  if (!/mot/i.test(said)) throw new Error('the MOT is missing from what was booked');
  if (!/michelin|tyre|235/i.test(said)) throw new Error('the tyres are missing from what was booked');
  console.log('\n  RESULT: tyres AND the MOT are both on one visit.');
  await prisma.$disconnect();
}

main().catch((e) => { console.error(`  FAILED: ${e?.message || e}`); process.exit(1); });
