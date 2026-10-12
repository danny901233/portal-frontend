#!/usr/bin/env node
/*
 * Turn the Companies House member matches into a contactable prospect list.
 *
 *   node backend/scripts/gh-ch-prospects.cjs ch-matches.json --csv out.csv
 *     [--garages names.txt] [--hl-contacts file] [--include-dissolved] [--limit N]
 *
 * Input is what gh-members-ch.cjs writes: { "<member name>": [ {company, number, ...} ] }.
 * Several members can direct the same company, so records are keyed on company number and
 * the directors collected -- that is the part the welcome-post list never had: a named
 * person to ask for.
 *
 * Registered office is frequently the accountant's address, not the workshop, so Places is
 * searched on the company name plus its town rather than trusting the postcode.
 */
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
try { require('dotenv').config(); } catch { /* env may already be set */ }

const M = require('./lib/prospect-match.cjs');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const INPUT = argv.find((a) => !a.startsWith('--') && !['--csv', '--garages', '--hl-contacts', '--limit'].includes(argv[argv.indexOf(a) - 1]));
const CSV_PATH = opt('--csv');
const LIMIT = Number(opt('--limit', '0'));
const KEEP_DISSOLVED = flag('--include-dissolved');

async function loadGarages() {
  const file = opt('--garages');
  if (file) {
    const txt = fs.readFileSync(file, 'utf8').trim();
    const names = txt.startsWith('[')
      ? JSON.parse(txt).map((g) => (typeof g === 'string' ? g : g.name))
      : txt.split('\n');
    const clean = names.map((n) => String(n).trim()).filter(Boolean);
    if (!clean.length) { console.error(`no garage names in ${file}`); process.exit(1); }
    console.log(`loaded ${clean.length} existing garages from ${file}`);
    return clean.map((name) => ({ name, source: 'portal' }));
  }
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.garage.findMany({ select: { name: true } });
    if (!rows.length) throw new Error('Garage table is empty');
    if (rows.length < M.MIN_PLAUSIBLE_GARAGES && !flag('--allow-small-db')) {
      console.error(`\nOnly ${rows.length} garages in this database -- that looks like a dev copy.`);
      console.error('Deduping against it would mark existing customers as new prospects.\n');
      process.exit(1);
    }
    console.log(`loaded ${rows.length} existing garages from the database`);
    return rows.map((r) => ({ name: r.name, source: 'portal' }));
  } catch (e) {
    console.error(`\nCannot read the garage list: ${e.message || e}`);
    console.error('Run on the EC2 box, or pass --garages <file>.\n');
    process.exit(1);
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

(async () => {
  const raw = JSON.parse(fs.readFileSync(INPUT, 'utf8'));

  // Collapse to one record per company, gathering every member who directs it.
  const byNumber = new Map();
  for (const [member, hits] of Object.entries(raw)) {
    for (const h of hits || []) {
      if (!byNumber.has(h.number)) {
        byNumber.set(h.number, {
          company: h.company, number: h.number, status: h.status,
          sic: h.sic, postcode: h.postcode, town: h.town,
          directors: new Set(), roles: new Set(),
        });
      }
      const rec = byNumber.get(h.number);
      rec.directors.add(member);
      if (h.role) rec.roles.add(h.role);
    }
  }

  let companies = [...byNumber.values()];
  const dissolved = companies.filter((c) => c.status !== 'active');
  if (!KEEP_DISSOLVED) companies = companies.filter((c) => c.status === 'active');
  if (LIMIT) companies = companies.slice(0, LIMIT);

  const garages = await loadGarages();
  const hl = await M.loadHighLevel(opt('--hl-contacts'));
  const known = [...garages, ...(hl || [])];
  if (hl) console.log(`loaded ${hl.length} HighLevel contacts`);

  console.log(`\n${Object.keys(raw).length} members processed -> ${byNumber.size} companies` +
    (KEEP_DISSOLVED ? '' : ` (${dissolved.length} dissolved/closed left out)`));

  const rows = [];
  for (const c of companies) {
    const m = M.bestMatch(c.company, known);
    const status = M.statusFor(m);
    const found = status === 'existing' ? null : await M.enrich(c.company, c.town || c.postcode);
    rows.push({
      ...c,
      // c.status is the Companies House state (active/dissolved); the match status below
      // would otherwise overwrite it on the spread and lose it.
      companyStatus: c.status,
      directors: [...c.directors].join('; '),
      match: m || { garage: '', source: '', score: 0, how: '' },
      status,
      place: found && !found.rejected ? found : null,
      rejectedPlace: found && found.rejected ? found.rejected : '',
    });
  }

  const pad = (s, n) => String(s || '').slice(0, n).padEnd(n);
  const fresh = rows.filter((r) => r.status === 'new');
  const checks = rows.filter((r) => r.status === 'check');
  const existing = rows.filter((r) => r.status === 'existing');

  console.log(`  new ${fresh.length} | check ${checks.length} | already known ${existing.length}`);
  if (!M.hasPlacesKey()) console.log('  NOTE: no Places key -- phone/website blank');
  if (!hl) console.log('  WARNING: HighLevel not checked -- pipeline garages will look new');
  const rej = rows.filter((r) => r.rejectedPlace);
  if (rej.length) console.log(`  ${rej.length} Places result(s) rejected as a different business`);

  console.log(`\n${pad('COMPANY', 34)} ${pad('DIRECTOR', 20)} ${pad('TOWN', 14)} ${pad('PHONE', 14)} WEBSITE`);
  for (const r of fresh.slice(0, 40)) {
    const p = r.place || {};
    console.log(`${pad(r.company, 34)} ${pad(r.directors.split(';')[0], 20)} ${pad(r.town, 14)} ${pad(p.phone, 14)} ${(p.website || '').slice(0, 32)}`);
  }
  if (existing.length) {
    console.log('\nALREADY KNOWN:');
    for (const r of existing.slice(0, 20)) console.log(`  ${pad(r.company, 34)} -> ${r.match.garage} [${r.match.source}]`);
  }

  if (CSV_PATH) {
    const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const head = ['company', 'company_number', 'company_status', 'directors', 'roles', 'sic',
      'town', 'postcode', 'phone', 'website', 'place_address', 'status', 'matched_to',
      'matched_in', 'score', 'rejected_place'];
    const lines = [head.join(',')];
    for (const r of rows) {
      const p = r.place || {};
      lines.push([r.company, r.number, r.companyStatus,
        r.directors, [...r.roles].join('; '), r.sic, r.town, r.postcode,
        p.phone, p.website, p.address, r.status, r.match.garage, r.match.source,
        r.match.score.toFixed(2), r.rejectedPlace].map(esc).join(','));
    }
    fs.mkdirSync(path.dirname(path.resolve(CSV_PATH)), { recursive: true });
    fs.writeFileSync(CSV_PATH, lines.join('\n'));
    console.log(`\nwrote ${rows.length} rows -> ${CSV_PATH}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
