#!/usr/bin/env node
/*
 * Put a free-of-charge garage into the HighLevel pipeline.
 *
 *   node scripts/mark-foc-partner.mjs --garage <id> --for "social media videos" [--apply]
 *   node scripts/mark-foc-partner.mjs --name jlk   --for "social media videos" [--apply]
 *
 * Dry run unless --apply, like the other prospecting scripts. Run from backend/ so dist/ and
 * @prisma/client resolve; .mjs because it imports the compiled service.
 *
 * The stage itself ("Live — FOC (content partner)") has to exist in HighLevel first: the private
 * integration token has no pipeline-write scope, so nothing here can create it. Without it the
 * opportunity still lands, parked in "Free trial live", and re-running this once the stage exists
 * moves it on — createOpportunity only ever moves a contact forward, so nothing duplicates.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const argv = process.argv.slice(2);
const opt = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const APPLY = argv.includes('--apply');
const GARAGE_ID = opt('--garage');
const NAME = opt('--name');
const IN_RETURN_FOR = opt('--for', 'social media content');

if (!GARAGE_ID && !NAME) {
  console.error('Pass --garage <id> or --name <part of the garage name>');
  process.exit(1);
}

const prisma = new PrismaClient();

const garages = GARAGE_ID
  ? await prisma.garage.findMany({ where: { id: GARAGE_ID }, select: { id: true, name: true, subscriptionCostGbp: true } })
  : await prisma.garage.findMany({
      where: { name: { contains: NAME, mode: 'insensitive' }, archivedAt: null },
      select: { id: true, name: true, subscriptionCostGbp: true },
    });

if (!garages.length) {
  console.error('No garage matched.');
  process.exit(1);
}

for (const g of garages) {
  console.log(`${APPLY ? 'MARKING' : 'would mark'} ${g.name} (${g.id}) as FOC — in return for: ${IN_RETURN_FOR}`);
  console.log(`  subscription on the account: £${g.subscriptionCostGbp ?? '—'}/month`);
  if (!APPLY) continue;
  const { markGarageAsFocPartner } = await import('../dist/services/focPartner.js');
  const r = await markGarageAsFocPartner({ garageId: g.id, inReturnFor: IN_RETURN_FOR });
  console.log('  ->', JSON.stringify(r));
  if (r.ok && !r.stageResolved) {
    console.log('  NOTE: the FOC stage does not exist yet — parked in "Free trial live". Create it, then re-run.');
  }
}

await prisma.$disconnect();
