#!/usr/bin/env node
// Tag the calls where the agent took an APPOINTMENT REQUEST, for garages that book by hand.
//
//   node scripts/backfill-booking-request-tag.cjs [--since 2026-10-01] [--garage <id>] [--commit]
//
// Dry run by default. Nothing is written without --commit.
//
// WHY THIS EXISTS
// For a garage that publishes no availability (the ecotestmsc group — Ecotest, Great Hollands,
// JDK Automotive) a booking is the request the agent took and handed over. A job that merely
// turned up for that registration afterwards is work the garage would have had anyway: they run
// their own diary. Crediting those ran their figures to roughly double — £12,020 against £5,889
// across October — so the dashboard now counts only `callType = 'booking request'` for them.
//
// Going forward the AGENT sets that tag itself, structurally: it knows the caller chose a service
// and the diary had nothing to offer. This script exists only because October predates that, and
// the information was never captured in a field — `callType` reads "general enquiry" or "other"
// on 250 of 251 calls, and `bookingDetails` is empty on all but one. The only record of what the
// caller wanted is the summary prose.
//
// PROVENANCE: this writes the same tag the agent will write, so the two are indistinguishable
// afterwards. They are separable by DATE — anything before the agent change shipped was tagged
// here, anything after by the agent. Worth remembering before trusting the tag as evidence of
// what the agent itself reported.
//
// Deliberately conservative: asked a price, chasing a job already in, "is it ready", a wrong
// number — none of those are appointment requests, and a false positive here credits the agent
// with a booking it never took, which is the whole problem we are fixing.
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const OpenAI = require('openai');
const prisma = new PrismaClient();

const COMMIT = process.argv.includes('--commit');
const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1];
};
const SINCE = arg('--since', '2026-10-01');
const ONLY_GARAGE = arg('--garage', null);

// Never overwrite a tag that already says something definite. 'confirmed booking' is the agent
// reporting it placed the job; 'booking request' is already done.
const RETAGGABLE = new Set(['general enquiry', 'general_enquiry', 'other', 'unknown', 'message_only', '']);

const SYSTEM = `A garage's AI receptionist answered a call. You are given the call summary.

Decide whether the caller ASKED TO GET THEIR VEHICLE BOOKED IN — an appointment request.

YES (an appointment request):
- they asked to book, or to be booked in, for any work
- they asked when the garage could take the car, or for the next availability
- they asked the team to ring them back TO ARRANGE or SORT a booking
- they named a day or a week they wanted, for work not yet booked
- they agreed to go ahead with work and left it with the garage to schedule

NO (not an appointment request):
- a price or quote enquiry with no request to book
- chasing or asking about work ALREADY booked or already in the workshop
- "is my car ready", collection times, progress updates
- an MOT reminder reply that declines, or says the car is sold or already done
- opening hours, directions, parts, a complaint, a wrong number, a silent call
- the caller rang off before saying what they wanted

If the summary does not make it clear that they wanted to be booked in, answer NO.

Answer with ONE word: YES or NO.`;

async function classify(openai, summary) {
  const text = String(summary || '').trim();
  if (!text) return null;
  const r = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0,
    max_tokens: 3,
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: text.slice(0, 2000) }],
  });
  const v = (r.choices[0]?.message?.content || '').trim().toUpperCase();
  return v.startsWith('YES') ? true : v.startsWith('NO') ? false : null;
}

(async () => {
  if (!process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY is not set — cannot classify.');
    process.exit(1);
  }
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // Only garages that book by hand. The flag already identifies them, so this never has to carry
  // a list of garage ids that would go stale the moment another garage turns its diary off.
  const conns = await prisma.garageHiveConnection.findMany({
    where: { attributeCallbackBookings: true, ...(ONLY_GARAGE ? { garageId: ONLY_GARAGE } : {}) },
    select: { garageId: true, garage: { select: { name: true } } },
  });
  if (!conns.length) return console.log('No by-hand garages to tag.');
  console.log(`${COMMIT ? 'COMMIT' : 'DRY RUN'} — ${conns.length} garage(s) that book by hand, calls since ${SINCE}\n`);

  let grandTagged = 0;
  for (const conn of conns) {
    const label = conn.garage?.name || conn.garageId;
    const calls = await prisma.call.findMany({
      where: { garageId: conn.garageId, createdAt: { gte: new Date(`${SINCE}T00:00:00Z`) } },
      select: { id: true, createdAt: true, callType: true, summary: true,
                registrationNumber: true, invoicedValue: true, invoiceStatus: true,
                confirmedBooking: true },
      orderBy: { createdAt: 'asc' },
    });
    const todo = calls.filter((c) => RETAGGABLE.has(String(c.callType || '').trim().toLowerCase()));
    console.log(`${label}: ${calls.length} calls, ${todo.length} eligible to retag`);

    let tagged = 0, skipped = 0, unclear = 0;
    const wouldTag = [];
    for (const c of todo) {
      let verdict;
      try {
        verdict = await classify(openai, c.summary);
      } catch (e) {
        console.error(`  ! ${c.id} classification failed: ${e.message.slice(0, 90)}`);
        continue;
      }
      if (verdict === null) { unclear++; continue; }
      if (!verdict) { skipped++; continue; }
      tagged++;
      wouldTag.push(c);
      const money = c.invoicedValue != null ? ` invoiced £${c.invoicedValue.toFixed(2)}` : '';
      console.log(`  + ${c.createdAt.toISOString().slice(0, 10)} ${String(c.registrationNumber || '-').padEnd(9)}`
        + ` "${String(c.summary || '').trim().slice(0, 70)}"${money}`);
      if (COMMIT) {
        await prisma.call.update({ where: { id: c.id }, data: { callType: 'booking request' } });
      }
    }
    console.log(`  -> ${tagged} tagged as a booking request, ${skipped} not a request, ${unclear} unclear/no summary`);
    grandTagged += tagged;

    // Preview what the dashboard will show for this garage. A dry run reports the same figures a
    // commit would produce, which is the point of running it dry first.
    const BILLED = new Set(['paid', 'open', 'corrective']);
    const alreadyCounted = calls.filter((c) =>
      c.confirmedBooking === true
      || String(c.callType || '').trim().toLowerCase() === 'booking request').length;
    const billedAll = calls
      .filter((c) => c.invoicedValue != null
        && BILLED.has(String(c.invoiceStatus || '').trim().toLowerCase()))
      .reduce((a, c) => a + c.invoicedValue, 0);
    // The figure that actually changes on the dashboard: billed value sitting on a call that
    // passes the gate. Everything else was the garage's own work and stops being counted.
    const isBilled = (c) => c.invoicedValue != null
      && BILLED.has(String(c.invoiceStatus || '').trim().toLowerCase());
    const keptValue = [
      ...wouldTag,
      ...calls.filter((c) => c.confirmedBooking === true
        || String(c.callType || '').trim().toLowerCase() === 'booking request'),
    ].filter(isBilled).reduce((a, c) => a + c.invoicedValue, 0);
    console.log(`  -> booked after this run: ${alreadyCounted + tagged}`
      + ` (${alreadyCounted} already counted + ${tagged} newly tagged)`);
    console.log(`  -> INVOICED VALUE the dashboard will show: £${keptValue.toFixed(2)}`
      + `  (was £${billedAll.toFixed(2)} across all ${calls.length} calls)`);
    console.log(`  -> dropped as the garage's own work: £${(billedAll - keptValue).toFixed(2)}\n`);
  }

  console.log(`${COMMIT ? 'Tagged' : 'Would tag'} ${grandTagged} call(s) as 'booking request'.`);
  if (!COMMIT) console.log('Re-run with --commit to write.');
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('FAILED:', e.message);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
