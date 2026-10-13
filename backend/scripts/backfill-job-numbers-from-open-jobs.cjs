#!/usr/bin/env node
// One-off: recover job numbers for bookings placed BEFORE bookingAt existed.
//
//   node scripts/backfill-job-numbers-from-open-jobs.cjs [--garage <id>] [--commit]
//
// Dry run by default. Nothing is written without --commit.
//
// WHY A SEPARATE SCRIPT FROM THE DAILY SWEEP
// The sweep matches a booking to a jobsheet on registration + appointment date, because that pair
// identifies a VISIT rather than a car. Bookings taken before the bookingAt column existed have no
// appointment date at all, so the sweep skips them — it reports "nothing awaiting a job number"
// and always will.
//
// For those, the only handle left is the "OB" service-type prefix. Speedy Spanners name their
// online-booking service types OB 4MOT, OB MI, OB INTSERV, OB DIAG and a bare OB; across their
// whole open diary that marked 10 jobs and every one matched a booking of ours, with no false
// positives. So it is good enough for a one-off recovery, where a human can read the output first
// — and NOT good enough for the daily path, because it is the garage's own naming convention
// rather than anything Garage Hive sets, and it could never tell us apart from another online
// booking source such as Garage Hive's own widget on the garage's website.
//
// It only works while the jobs are still OPEN. `jobsheets` holds open work only, so once the
// garage posts a job it leaves that list and the link is unrecoverable. That is the whole reason
// this runs now rather than later.
//
// Ambiguity is refused, never guessed. A wrong job number is worse than none: it attaches another
// customer's invoice to our booking permanently, and nothing downstream ever revisits it.
require('dotenv').config();

const path = require('path');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1];
}
const COMMIT = process.argv.includes('--commit');
const ONLY_GARAGE = arg('--garage', null);

async function main() {
  const mod = await import(
    require('url').pathToFileURL(
      path.join(__dirname, '..', 'dist', 'services', 'garageHiveJobMatch.js'),
    ).href
  );
  const { fetchOpenJobsheets, isAgentPlacedJob, normaliseReg, bookingAtFrom } = mod;

  const connections = await prisma.garageHiveConnection.findMany({
    where: ONLY_GARAGE ? { garageId: ONLY_GARAGE } : {},
    select: { garageId: true, garage: { select: { name: true } } },
  });

  let wrote = 0;
  let skipped = 0;

  for (const conn of connections) {
    const label = conn.garage?.name || conn.garageId;

    let jobs;
    try {
      jobs = await fetchOpenJobsheets(conn.garageId);
    } catch (e) {
      // Four of the eight Business Central garages answer 401 on every read (their tenants never
      // granted the Azure app, or granted a different one). Not this script's problem to solve,
      // and not a reason to abandon the garages that do work.
      console.log(`${label}: BC read failed (${e.message.slice(0, 60)}) — skipping`);
      continue;
    }

    const placed = jobs.filter((j) => isAgentPlacedJob(j.serviceType));
    if (!placed.length) {
      // Expected on the garages that book by hand: they have no online bookings at all, so there
      // is nothing here to recover. Their attribution starts from new calls going forward.
      console.log(`${label}: no online-booking jobs open — nothing to recover`);
      continue;
    }

    // Only bookings still missing a job number, and only ones WE placed. A message-only lead has
    // no appointment of ours to tie to an "OB" job.
    const calls = await prisma.call.findMany({
      where: {
        garageId: conn.garageId,
        confirmedBooking: true,
        registrationNumber: { not: null },
        diaryJobNumber: null,
      },
      select: { id: true, createdAt: true, registrationNumber: true, customerName: true, bookingAt: true },
      orderBy: { createdAt: 'asc' },
    });

    console.log(`\n${label}: ${placed.length} online-booking job(s) open, ${calls.length} booking(s) without a job number`);

    for (const job of placed) {
      const reg = normaliseReg(job.vehicleRegistrationNo);
      const hits = calls.filter((c) => normaliseReg(c.registrationNumber) === reg);

      if (hits.length !== 1) {
        skipped++;
        console.log(
          `   SKIP ${job.number} ${reg.padEnd(9)} — ${hits.length === 0 ? 'no booking of ours for this registration' : `${hits.length} bookings match, cannot tell which`}`,
        );
        continue;
      }

      const call = hits[0];
      const appointment = bookingAtFrom(job.bookingDate, job.bookingTime);
      if (!appointment) {
        // An appointment we cannot read is not one we can defend later.
        skipped++;
        console.log(`   SKIP ${job.number} ${reg.padEnd(9)} — unreadable bookingDate ${JSON.stringify(job.bookingDate)}`);
        continue;
      }

      console.log(
        `   ${COMMIT ? 'WRITE' : 'would write'} ${job.number} ${reg.padEnd(9)}` +
        ` appt ${job.bookingDate} (${job.serviceType})` +
        ` -> call ${call.id} ${call.customerName || '?'}`,
      );

      if (COMMIT) {
        await prisma.call.update({
          where: { id: call.id },
          data: {
            diaryJobNumber: job.number,
            // Only fill the appointment if we do not already have one. A date the agent actually
            // sent is better evidence than one inferred from the diary afterwards.
            ...(call.bookingAt ? {} : { bookingAt: appointment }),
          },
        });
      }
      wrote++;
    }
  }

  console.log(
    `\n${COMMIT ? 'Wrote' : 'Would write'} ${wrote} job number(s), skipped ${skipped}.` +
    (COMMIT ? '' : ' Re-run with --commit to save.'),
  );
}

main()
  .catch((e) => {
    console.error('backfill failed:', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
