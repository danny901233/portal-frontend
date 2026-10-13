#!/usr/bin/env node
// Recover invoiced value for bookings whose job was ALREADY POSTED before we captured job numbers.
//
//   node scripts/backfill-invoices-by-inference.cjs [--garage <id>] [--commit]
//
// Dry run by default. Nothing is written without --commit.
//
// The job-number route cannot reach these: they left the open-jobsheet list when the garage
// posted them, so reg+date -> job number is gone. The invoices still exist, only the link is lost.
// Recovering it means the same inference that produced the original £7,879 figure:
//   reg -> vehicle -> customer -> their first UNCLAIMED invoice within 45 days of the call
// One invoice per booking, consumed once. Without that rule a repeat customer's later unrelated
// work counts as ours and the total over-reads (£9,674 vs £7,879 on this very garage).
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
// Same fortnight the nightly sweep uses. A backfill that reached further would claim bookings
// the live system would never credit, and the two figures would disagree forever after.
const WINDOW = 14;

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1];
}
const COMMIT = process.argv.includes('--commit');
const ONLY_GARAGE = arg('--garage', null);
// How far back to look. Deliberately not "all history": the further back it reaches the more it
// is claiming about calls nobody remembers, and the invoices it matches drift further from the
// call that supposedly caused them.
const SINCE = arg('--since', '2026-10-01');

async function token(c) {
  const b = new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret,
    scope: 'https://api.businesscentral.dynamics.com/.default', grant_type: 'client_credentials' });
  const r = await fetch(`https://login.microsoftonline.com/${c.tenantId}/oauth2/v2.0/token`,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: b.toString() });
  const j = await r.json();
  if (!j.access_token) throw new Error(JSON.stringify(j).slice(0, 160));
  return j.access_token;
}
let HDR;
async function all(url, max = 60) {
  const out = []; let next = url;
  for (let i = 0; i < max && next; i++) {
    const r = await fetch(next, { headers: HDR });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 150)}`);
    const j = await r.json(); out.push(...(j.value || [])); next = j['@odata.nextLink'];
  }
  return out;
}
const norm = (s) => String(s || '').replace(/\s+/g, '').trim().toUpperCase();
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const lag = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);

(async () => {
  const conns = await prisma.garageHiveConnection.findMany({
    where: ONLY_GARAGE ? { garageId: ONLY_GARAGE } : {},
    select: { garageId: true, tenantId: true, environmentName: true, companyId: true,
              clientId: true, clientSecret: true, attributeCallbackBookings: true,
              garage: { select: { name: true } } },
  });

  let grandN = 0, grandV = 0;
  for (const conn of conns) {
    const label = conn.garage?.name || conn.garageId;
    const c = { tenantId: conn.tenantId, environmentName: conn.environmentName, companyId: conn.companyId,
      clientId: conn.clientId || process.env.GARAGEHIVE_CLIENT_ID,
      clientSecret: conn.clientSecret || process.env.GARAGEHIVE_CLIENT_SECRET };

    // Bookings WE placed that still have no job number. Message-only leads are excluded: their
    // attribution is a different, looser question and is not what this recovers.
    // On a callback garage nothing is ever flagged confirmedBooking — they publish no
    // availability, so the agent books nothing and every booking request arrives as a message.
    // Requiring that flag there would match nothing at all.
    const calls = await prisma.call.findMany({
      where: {
        garageId: conn.garageId,
        createdAt: { gte: new Date(`${SINCE}T00:00:00Z`) },
        registrationNumber: { not: null },
        diaryJobNumber: null,
        ...(conn.attributeCallbackBookings ? {} : { confirmedBooking: true }),
      },
      select: { id: true, createdAt: true, registrationNumber: true, customerName: true, capturedRevenue: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!calls.length) continue;

    try { HDR = { Authorization: `Bearer ${await token(c)}` }; }
    catch (e) { console.log(`\n${label}: auth failed — ${e.message.slice(0, 60)}`); continue; }

    const root = `https://api.businesscentral.dynamics.com/v2.0/${c.tenantId}/${c.environmentName}`;
    const GEN = `${root}/api/garageHive/general/v2.0/companies(${c.companyId})`;
    const STD = `${root}/api/v2.0/companies(${c.companyId})`;

    const regs = [...new Set(calls.map((x) => norm(x.registrationNumber)).filter(Boolean))];
    const vmap = new Map();
    try {
      for (let i = 0; i < regs.length; i += 15) {
        const f = regs.slice(i, i + 15).map((r) => `registrationNo eq '${r.replace(/'/g, "''")}'`).join(' or ');
        for (const v of await all(`${GEN}/vehicles?$filter=${encodeURIComponent(f)}&$select=registrationNo,customerNo`))
          vmap.set(norm(v.registrationNo), v.customerNo);
      }
    } catch (e) { console.log(`\n${label}: vehicle read failed — ${e.message.slice(0, 60)}`); continue; }

    const earliest = calls[0].createdAt.toISOString().slice(0, 10);
    let inv;
    try {
      inv = (await all(`${STD}/salesInvoices?$filter=postingDate ge ${earliest}&$select=number,postingDate,customerNumber,totalAmountExcludingTax,status&$orderby=postingDate asc`))
        .filter((i) => (i.number || '').startsWith('SJ'));
    } catch (e) { console.log(`\n${label}: invoice read failed — ${e.message.slice(0, 60)}`); continue; }

    const byCust = new Map();
    for (const i of inv) { if (!byCust.has(i.customerNumber)) byCust.set(i.customerNumber, []); byCust.get(i.customerNumber).push(i); }

    const used = new Set();
    const rows = [];
    let n = 0, v = 0, unmatched = 0;
    for (const call of calls) {
      const day = call.createdAt.toISOString().slice(0, 10);
      const cust = vmap.get(norm(call.registrationNumber));
      const hit = (byCust.get(cust) || []).find((i) => !used.has(i.number)
        && i.postingDate >= day && i.postingDate <= addDays(day, WINDOW));
      if (!hit) { unmatched++; continue; }
      used.add(hit.number);
      n++; v += hit.totalAmountExcludingTax || 0;
      if (COMMIT) {
        await prisma.call.update({
          where: { id: call.id },
          data: {
            // The invoice number IS the job number in Business Central, so this fills both.
            diaryJobNumber: hit.number,
            diaryJobSource: 'inferred',
            invoicedValue: hit.totalAmountExcludingTax ?? null,
            invoicedAt: hit.postingDate ? new Date(`${hit.postingDate}T00:00:00Z`) : null,
            invoiceStatus: (hit.status || '').trim() || 'Unknown',
          },
        });
      }
      const q = typeof call.capturedRevenue === 'number' ? call.capturedRevenue : null;
      rows.push(`  ${day} ${norm(call.registrationNumber).padEnd(9)} ${String(call.customerName || '?').slice(0,16).padEnd(16)}`
        + ` -> ${hit.number} ${hit.postingDate} £${(hit.totalAmountExcludingTax || 0).toFixed(2)} ${hit.status}`
        + ` (+${lag(day, hit.postingDate)}d${q != null ? `, quoted £${q.toFixed(2)}` : ', no quote'})`);
    }
    console.log(`\n${label}: ${COMMIT ? 'wrote' : 'would write'} ${n} of ${calls.length} bookings — £${v.toFixed(2)} ex VAT; ${unmatched} unmatched`);
    rows.forEach((r) => console.log(r));
    grandN += n; grandV += v;
  }
  console.log(`\nTOTAL ${COMMIT ? 'written' : 'would write'}: ${grandN} rows, £${grandV.toFixed(2)} ex VAT`
    + (COMMIT ? ', all tagged diaryJobSource=inferred.' : '. NOTHING WRITTEN — re-run with --commit.'));
  await prisma.$disconnect();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
