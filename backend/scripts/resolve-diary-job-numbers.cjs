#!/usr/bin/env node
// Resolve the garage's own job number for bookings we placed, so they can be valued.
//
//   node -r dotenv/config scripts/resolve-diary-job-numbers.cjs [--garage <id>] [--days 90] [--commit]
//
// Dry run by default. Nothing is written without --commit.
//
// WHY THIS EXISTS
// Garage Hive's online-booking API answers a booking with its own id (a bare integer, 1739272).
// Nothing on the Business Central side records it — externalDocumentNo, marketingChannel,
// keyTagText and serviceAdvisor are all empty on every agent-placed jobsheet — so that id cannot
// be turned into "SJ000829" by asking. What CAN be matched is the registration plus the
// appointment date, because that pair identifies a VISIT rather than a car. Once we have the job
// number, the invoiced value is free: in Business Central a posted sales invoice carries the SAME
// number as the jobsheet it came from.
//
// WHY IT HAS TO RUN OFTEN
// `jobsheets` holds OPEN work only (a documentType filter for anything else returns zero rows).
// Once the garage posts the job it leaves that list and the link can no longer be made. So this
// must see a booking while it is still in the diary — run it daily, not monthly.
//
// Two kinds of garage, two matchers:
//   - garages we book into          -> matchJobsheet, on registration + the slot we took
//   - garages that only take a message (Ecotest, Great Hollands, JDK Camberley) -> matchMessageLead
//     on registration + "a job appeared that did not exist when they rang", and ONLY for calls
//     where the caller gave a preferred date. That last condition is what makes the figure
//     defensible: without it, someone ringing about a car already in the bay counts as won work,
//     which inflated a first pass on those three by £12,737 of same-day invoices.

// Loaded here rather than relying on `node -r dotenv/config`, so the script works the same way
// however it is started — by hand, or by pm2's cron, which passes no interpreter args. Run it from
// the backend directory so @prisma/client and dotenv resolve.
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
const DAYS = Number(arg('--days', 90));

async function main() {
  // Compiled, because the matchers are TypeScript. dist/ is emitted as ES modules, so this has to
  // be a dynamic import even though the script itself is .cjs — a plain require() of it fails with
  // ERR_REQUIRE_ESM. The script stays .cjs because that is what resolves @prisma/client here.
  const matcher = await import(
    require('url').pathToFileURL(path.join(__dirname, '..', 'dist', 'services', 'garageHiveJobMatch.js')).href
  );
  const { matchJobsheet, matchMessageLead, fetchOpenJobsheets, isAgentPlacedJob,
          fetchInvoicesByJobNumber, bookingAtFrom } = matcher;

  const since = new Date(Date.now() - DAYS * 86_400_000);

  // Only garages on Business Central can be matched at all: the job number lives there, and the
  // online-booking API never returns it. A garage with no GarageHiveConnection row is not missing
  // credentials, it is on a different Garage Hive product entirely.
  const connections = await prisma.garageHiveConnection.findMany({
    where: ONLY_GARAGE ? { garageId: ONLY_GARAGE } : {},
    select: {
      garageId: true,
      // Whether this garage's hand-booked work may be credited to the call that asked for it.
      // On by default for nobody; today only the JDK group (Ecotest / Great Hollands / JDK
      // Camberley), who take no bookings at all.
      attributeCallbackBookings: true,
      garage: { select: { name: true } },
    },
  });

  if (!connections.length) {
    console.log('No Business Central garages to sweep.');
    return;
  }

  let totalResolved = 0;
  for (const conn of connections) {
    const label = conn.garage?.name || conn.garageId;

    const calls = await prisma.call.findMany({
      where: {
        garageId: conn.garageId,
        createdAt: { gte: since },
        registrationNumber: { not: null },
        diaryJobNumber: null,
        // On a garage we book for, an appointment date is what the match is made on, so a call
        // without one cannot be matched. On a callback garage there is no appointment of ours at
        // all — the match is "a job appeared for this registration that did not exist when they
        // rang" — so requiring a date here would exclude almost every call they take.
        ...(conn.attributeCallbackBookings
          ? {}
          : { bookingAt: { not: null }, confirmedBooking: true }),
      },
      select: {
        id: true, createdAt: true, registrationNumber: true,
        bookingAt: true, confirmedBooking: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    if (!calls.length) {
      console.log(`${label}: nothing awaiting a job number`);
      continue;
    }

    let jobs;
    try {
      jobs = await fetchOpenJobsheets(conn.garageId);
    } catch (e) {
      // One garage's expired credential must not stop the rest of the sweep.
      console.error(`${label}: could not read the diary — ${e.message}`);
      continue;
    }

    let resolved = 0;
    let duplicates = 0;
    const unmatched = [];
    // One job is one booking. A customer who rings twice about the same car — to ask, then to
    // chase — otherwise has both calls matched to the same job and counted as two bookings.
    // Calls are ordered oldest first, so the call that earned the booking claims it and any
    // later one asking about the same work does not.
    const claimed = new Set();
    for (const call of calls) {
      // confirmedBooking tells the two matchers apart. True means we put it in the diary, so the
      // appointment date is ours and can be matched directly. False with a bookingAt means the
      // agent took a message naming a date the caller wanted — a booking REQUEST — and the garage
      // booked it by hand afterwards.
      // A belt-and-braces pair with the query filter above: the message matcher is looser by
      // design, so it must never run for a garage that has not been opted in.
      const hit = call.confirmedBooking
        ? matchJobsheet({ registration: call.registrationNumber, bookingAt: call.bookingAt }, jobs)
        : !conn.attributeCallbackBookings
        ? null
        : matchMessageLead(
            {
              registration: call.registrationNumber,
              calledAt: call.createdAt,
              preferredDate: call.bookingAt,
            },
            jobs,
          );

      if (!hit) {
        unmatched.push(`${call.createdAt.toISOString().slice(0, 10)} ${call.registrationNumber}`);
        continue;
      }
      if (claimed.has(hit.number)) {
        duplicates++;
        continue;
      }
      claimed.add(hit.number);

      const how = call.confirmedBooking ? 'placed' : 'message->callback';
      const marker = isAgentPlacedJob(hit.serviceType) ? ' [OB]' : '';
      // bookingAt is null on a callback garage — there is no appointment of OURS, which is the
      // whole point of that path. Report the call date instead of assuming one exists; reading
      // .toISOString() off null here crashed the sweep before it reached a single one of them.
      const when = call.bookingAt
        ? `appt ${call.bookingAt.toISOString().slice(0, 10)}`
        : `called ${call.createdAt.toISOString().slice(0, 10)}`;
      console.log(
        `${label}: ${call.registrationNumber} ${when}` +
        ` -> ${hit.number} (${hit.serviceType || 'no service type'})${marker} [${how}]`,
      );

      if (COMMIT) {
        await prisma.call.update({
          where: { id: call.id },
          // 'matched': this came off a real jobsheet, registration and appointment date agreeing.
          // Distinct from the inference backfill, which cannot claim that.
          data: {
            diaryJobNumber: hit.number,
            diaryJobSource: 'matched',
            // On a callback garage we have no appointment of our own; the one the garage set when
            // they booked it by hand is the only appointment there is, so take it from the job.
            ...(call.bookingAt ? {} : { bookingAt: bookingAtFrom(hit.bookingDate, hit.bookingTime) }),
          },
        });
      }
      resolved++;
    }

    totalResolved += resolved;
    console.log(
      `${label}: resolved ${resolved}/${calls.length}` +
      (duplicates ? `, ${duplicates} later call(s) about a job already claimed` : '') +
      (unmatched.length ? `, unmatched: ${unmatched.slice(0, 8).join(', ')}` +
        (unmatched.length > 8 ? ` (+${unmatched.length - 8} more)` : '') : ''),
    );
  }

  console.log(
    `\n${COMMIT ? 'Wrote' : 'Would write'} ${totalResolved} job number(s).` +
    (COMMIT ? '' : ' Re-run with --commit to save.'),
  );

  // ── Second pass: what did those jobs invoice for? ────────────────────────────────────────────
  // Separate from the first on purpose. Resolving the job number is urgent — the jobsheet has to
  // still be open — whereas the invoice appears days or weeks later and can be picked up at
  // leisure. A job with no invoice yet is simply absent from the lookup and gets asked about
  // again tomorrow, so this is safe to run every night from the moment the number is known.
  let totalInvoiced = 0;
  let totalValue = 0;
  for (const conn of connections) {
    const label = conn.garage?.name || conn.garageId;

    const awaiting = await prisma.call.findMany({
      where: { garageId: conn.garageId, diaryJobNumber: { not: null }, invoicedValue: null },
      select: { id: true, diaryJobNumber: true, registrationNumber: true, capturedRevenue: true },
    });
    if (!awaiting.length) continue;

    let invoices;
    try {
      invoices = await fetchInvoicesByJobNumber(
        conn.garageId,
        awaiting.map((c) => c.diaryJobNumber),
      );
    } catch (e) {
      console.error(`${label}: invoice read failed — ${e.message.slice(0, 80)}`);
      continue;
    }

    let found = 0;
    for (const call of awaiting) {
      const facts = invoices.get(call.diaryJobNumber);
      if (!facts) continue;
      found++;
      totalValue += facts.invoicedValue;

      // The gap between what we quoted and what it invoiced is the number worth having: an MOT
      // quoted at £54.85 that invoices at £208 is work the garage found on the ramp, and it is
      // invisible anywhere else.
      const quoted = typeof call.capturedRevenue === 'number' ? call.capturedRevenue : null;
      const delta = quoted == null ? '' :
        ` (quoted £${quoted.toFixed(2)}, ${facts.invoicedValue >= quoted ? '+' : ''}£${(facts.invoicedValue - quoted).toFixed(2)})`;
      console.log(
        `${label}: ${call.diaryJobNumber} ${call.registrationNumber || ''} invoiced ` +
        `£${facts.invoicedValue.toFixed(2)} ex VAT ${facts.invoiceStatus}${delta}`,
      );

      if (COMMIT) {
        await prisma.call.update({
          where: { id: call.id },
          data: {
            invoicedValue: facts.invoicedValue,
            invoicedAt: facts.invoicedAt,
            invoiceStatus: facts.invoiceStatus,
          },
        });
      }
    }
    totalInvoiced += found;
    console.log(`${label}: ${found}/${awaiting.length} resolved job(s) now invoiced`);
  }

  console.log(
    `${COMMIT ? 'Wrote' : 'Would write'} ${totalInvoiced} invoice value(s), ` +
    `£${totalValue.toFixed(2)} ex VAT in total.`,
  );
}

main()
  .catch((e) => {
    console.error('sweep failed:', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
