#!/usr/bin/env node
/**
 * Move garages between voice agents, and put the config back in sync afterwards.
 *
 * Written for the 2026-09-21 v3 -> unified migration so that going BACK is one command at 7am
 * rather than an archaeology exercise. The old v3 trunks and dispatch rules were deliberately
 * left in place on the `receptionmate` project, so a rollback needs no LiveKit work at all —
 * only the agentScript, which is what voice.ts reads to pick a SIP domain.
 *
 *   node scripts/agent-script-switch.cjs --to v3               # dry run, shows what would move
 *   node scripts/agent-script-switch.cjs --to v3 --apply       # roll everything back
 *   node scripts/agent-script-switch.cjs --to unified --apply  # forward again
 *   node scripts/agent-script-switch.cjs --to v3 --apply --only <garageId>
 *
 * Always re-syncs DynamoDB after a change. Skipping that is what filled the inbox with config
 * drift alerts the first time: the watchdog compares Postgres updatedAt against the agent's copy
 * and a direct write moves only one of them.
 */
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

const SCRIPTS = { v3: 'receptionmate-agent-v3', unified: 'unified-agent' };
const to = SCRIPTS[val('--to')];
if (!to) {
  console.error('Usage: --to v3|unified [--apply] [--only <garageId>]');
  process.exit(1);
}
const from = to === SCRIPTS.v3 ? SCRIPTS.unified : SCRIPTS.v3;
const APPLY = has('--apply');
const ONLY = val('--only');

(async () => {
  const rows = await prisma.agentConfiguration.findMany({
    where: { agentScript: from, garage: { archivedAt: null }, ...(ONLY ? { garageId: ONLY } : {}) },
    select: { garageId: true, garage: { select: { name: true } } },
    orderBy: { garageId: 'asc' },
  });

  console.log(`${rows.length} garage(s) ${from} -> ${to}${APPLY ? '  *** APPLYING ***' : '  (dry run — add --apply)'}`);
  if (!rows.length || !APPLY) {
    for (const r of rows) console.log('   ', r.garage.name);
    await prisma.$disconnect();
    return;
  }

  const moved = [];
  for (const r of rows) {
    await prisma.agentConfiguration.update({ where: { garageId: r.garageId }, data: { agentScript: to } });
    moved.push(r);
    console.log('  moved   ', r.garage.name);
  }

  // Push Postgres -> DynamoDB so the watchdog does not report drift for every garage touched.
  let sync;
  try {
    ({ sendAgentConfigWebhook: sync } = await import(
      'file://' + path.join(__dirname, '..', 'dist', 'routes', 'config.js')));
  } catch (err) {
    console.error('\n! Could not load the config sync:', err.message);
    console.error('! The switch IS done, but run a re-save so the agents match the portal.');
    await prisma.$disconnect();
    return;
  }

  let ok = 0;
  for (const r of moved) {
    try { await sync(r.garageId); ok++; } catch (e) { console.error('  sync failed', r.garage.name, e.message); }
  }
  console.log(`\n${moved.length} switched, ${ok} re-synced to DynamoDB.`);
  await prisma.$disconnect();
})();
