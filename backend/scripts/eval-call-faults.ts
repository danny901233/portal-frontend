/**
 * Does the analyst pass agree with the garages?
 *
 * The ground truth is `CallFeedback`: a thumbs-down is a garage saying this call
 * was wrong, and a thumbs-up is a garage saying it was fine. Neither is perfect
 * — a garage can mark a call down over something the agent handled correctly —
 * but it is the only verdict on these calls that is not mine.
 *
 * Two named calls are checked by hand because I know the answer and got it
 * wrong: 16056346 (a plate the caller never said, acted on) must be found, and
 * 35204772 (Elite Autocare, an earlier drop-off) must stay silent.
 *
 *   npx tsx scripts/eval-call-faults.ts [--limit=20] [--days=7]
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

import { findCallFaults } from '../src/services/callFaults.js';

const prisma = new PrismaClient();

const MUST_FIND = '16056346';     // the unverified vehicle
const MUST_STAY_SILENT = '35204772'; // the drop-off Dan corrected me on

async function main() {
  const limitArg = process.argv.find((a) => a.startsWith('--limit='));
  const daysArg = process.argv.find((a) => a.startsWith('--days='));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : 20;
  const days = daysArg ? Number(daysArg.split('=')[1]) : 7;
  const since = new Date(Date.now() - days * 86400000);

  const feedback = await prisma.callFeedback.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    select: { callId: true, rating: true, reasons: true, notes: true },
  });

  const down = feedback.filter((f) => f.rating === 'down');
  const up = feedback.filter((f) => f.rating === 'up');
  const half = Math.max(1, Math.floor(limit / 2));
  const wanted = [
    ...down.slice(0, half).map((f) => ({ id: f.callId, label: 'down', notes: f.notes })),
    ...up.slice(0, half).map((f) => ({ id: f.callId, label: 'up', notes: f.notes })),
    { id: MUST_FIND, label: 'known-fault', notes: 'plate never spoken, acted on' },
    { id: MUST_STAY_SILENT, label: 'known-clean', notes: 'earlier drop-off, nothing can answer it' },
  ];
  const byId = new Map(wanted.map((w) => [w.id, w]));

  const calls = await prisma.call.findMany({
    where: { id: { in: [...byId.keys()] } },
    select: {
      id: true, summary: true, callType: true, confirmedBooking: true,
      metrics: true, transcript: true, garage: { select: { name: true } },
    },
  });
  console.log(`labelled calls found: ${calls.length} of ${byId.size} asked for\n`);

  const tally = { down: { flagged: 0, total: 0 }, up: { flagged: 0, total: 0 } };

  for (const c of calls) {
    const want = byId.get(c.id)!;
    const r = await findCallFaults({
      transcript: c.transcript, metrics: c.metrics, summary: c.summary ?? undefined,
      callType: c.callType ?? undefined, confirmedBooking: c.confirmedBooking ?? false,
    });
    const findings = r?.findings ?? [];
    const top = findings.filter((f) => f.severity !== 'low');

    if (want.label === 'down') { tally.down.total += 1; if (top.length) tally.down.flagged += 1; }
    if (want.label === 'up') { tally.up.total += 1; if (top.length) tally.up.flagged += 1; }

    const verdict = want.label === 'known-fault' ? (top.length ? 'PASS' : 'MISS')
      : want.label === 'known-clean' ? (top.length ? 'FALSE POSITIVE' : 'PASS')
        : '';
    console.log(`[${want.label}${verdict ? ' ' + verdict : ''}] ${c.id} ${c.garage?.name ?? ''}`
      + (want.notes ? ` — garage said: ${String(want.notes).slice(0, 90)}` : ''));
    if (!findings.length) console.log('    (nothing found)');
    for (const f of findings) {
      console.log(`    ${f.severity.padEnd(6)} ${f.category.padEnd(20)} ${f.headline}`);
      console.log(`           ${f.detail.slice(0, 160)}`);
      if (f.evidence) console.log(`           evidence: "${f.evidence.slice(0, 110)}"`);
    }
    console.log('');
  }

  console.log('── agreement with the garages ──');
  console.log(`thumbs-DOWN calls where it found a fault: ${tally.down.flagged}/${tally.down.total}`);
  console.log(`thumbs-UP calls where it found a fault:   ${tally.up.flagged}/${tally.up.total}`
    + '  (lower is better, but a garage liking a call does not make it faultless)');
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
