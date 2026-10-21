/**
 * Run today's calls through both passes and print what they find, so it can be
 * held against what a human (me) reported on the same calls.
 *
 *   npx tsx scripts/review-today.ts [--hours=24] [--only=id,id]
 *
 * Both passes run on every call, and the deterministic findings are handed to
 * the analyst as established fact — that is the arrangement the two are meant
 * to work in, so it is the one that gets measured.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

import { findCallFaults } from '../src/services/callFaults.js';

// backend/package.json is "type": "module", so the CommonJS scanner is loaded
// through createRequire rather than a bare require.
import { createRequire } from 'node:module';

const { scanDefects } = createRequire(import.meta.url)('./lib/call-defects.cjs');

const prisma = new PrismaClient();

async function main() {
  const hoursArg = process.argv.find((a) => a.startsWith('--hours='));
  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const hours = hoursArg ? Number(hoursArg.split('=')[1]) : 24;
  const only = onlyArg ? onlyArg.split('=')[1].split(',').filter(Boolean) : null;
  const since = new Date(Date.now() - hours * 3600 * 1000);

  const calls = await prisma.call.findMany({
    where: only
      ? { id: { in: only } }
      : { createdAt: { gte: since }, garage: { isTestAccount: false, archivedAt: null } },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, garageId: true, createdAt: true, durationSeconds: true, summary: true,
      callType: true, confirmedBooking: true, registrationNumber: true,
      metrics: true, transcript: true, garage: { select: { name: true } },
    },
  });

  const feedback = await prisma.callFeedback.findMany({
    where: { callId: { in: calls.map((c) => c.id) } },
    select: { callId: true, rating: true, reasons: true, notes: true },
  });
  const ratingOf = new Map(feedback.map((f) => [f.callId, f]));

  console.log(`${calls.length} calls in the last ${hours}h\n`);
  const tally: Record<string, number> = {};
  let quiet = 0;

  for (const c of calls) {
    const row = { ...c, garageName: c.garage?.name ?? null };
    const mech = scanDefects([row], { feedback: feedback.filter((f) => f.callId === c.id) });
    const ai = await findCallFaults({
      transcript: c.transcript, metrics: c.metrics, summary: c.summary ?? undefined,
      callType: c.callType ?? undefined, confirmedBooking: c.confirmedBooking ?? false,
      knownSignals: mech.map((f: { detail: string }) => f.detail),
    });
    const aiFindings = (ai?.findings ?? []).filter((f) => f.severity !== 'low');

    for (const f of mech) tally[`mech:${f.signature}`] = (tally[`mech:${f.signature}`] || 0) + 1;
    for (const f of aiFindings) tally[`ai:${f.category}`] = (tally[`ai:${f.category}`] || 0) + 1;
    if (!mech.length && !aiFindings.length) { quiet += 1; continue; }

    const fb = ratingOf.get(c.id);
    console.log(`── ${c.id} ${row.garageName ?? ''} ${c.durationSeconds}s`
      + `${fb ? `  [garage: ${fb.rating}${fb.notes ? ' — ' + String(fb.notes).slice(0, 60) : ''}]` : ''}`);
    for (const f of mech) console.log(`   DATA ${f.severity.padEnd(6)} ${f.signature}: ${String(f.detail).slice(0, 150)}`);
    for (const f of aiFindings) {
      console.log(`   READ ${f.severity.padEnd(6)} ${f.category}: ${f.headline}`);
      console.log(`        ${f.detail.slice(0, 220)}`);
      if (f.evidence) console.log(`        "${f.evidence.slice(0, 120)}"`);
    }
    console.log('');
  }

  console.log('── totals ──');
  console.log(`calls with nothing found: ${quiet}/${calls.length}`);
  for (const k of Object.keys(tally).sort((a, b) => tally[b] - tally[a])) console.log(`  ${k}: ${tally[k]}`);
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
