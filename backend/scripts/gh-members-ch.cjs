#!/usr/bin/env node
/*
 * Match Garage Hive Community members to the garages they direct, via Companies House.
 *
 *   node backend/scripts/gh-members-ch.cjs members.json [--out found.json] [--limit N]
 *
 * members.json is [{ id, name }] from the group's member list. For each name we search
 * the officer register, keep officers whose name actually contains every word searched
 * for, read their appointments, and keep companies whose SIC code says motor trade.
 *
 * The SIC filter is what makes this work at all: searching "Mark Carter" returns a
 * hundred people, but almost none of them direct a vehicle repair company, so the
 * filter disambiguates far better than the name ever could.
 *
 * Companies House allows 600 requests per 5 minutes. At ~6 calls per member this is a
 * multi-hour run, so it rate-limits itself and checkpoints after every name -- re-running
 * with the same --out resumes where it stopped instead of starting again.
 */
const fs = require('fs');
try { require('dotenv').config(); } catch { /* key may already be exported */ }

const KEY = process.env.COMPANIES_HOUSE_API_KEY || process.env.CH_API_KEY || '';
if (!KEY) { console.error('Set COMPANIES_HOUSE_API_KEY'); process.exit(1); }
const AUTH = 'Basic ' + Buffer.from(KEY + ':').toString('base64');

const argv = process.argv.slice(2);
const opt = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const INPUT = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--out' && argv[argv.indexOf(a) - 1] !== '--limit');
const OUT = opt('--out', 'ch-matches.json');
const LIMIT = Number(opt('--limit', '0'));

// Motor trade: vehicle maintenance and repair, sales, parts, tyres, bodywork, recovery.
const GARAGE_SIC = new Set(['45200', '45112', '45111', '45310', '45320', '45190', '45400', '50200', '77120']);

// 600 requests / 5 minutes. Stay under it rather than discovering the limit the hard way.
let last = 0;
const MIN_GAP_MS = 560;
const throttle = async () => {
  const wait = MIN_GAP_MS - (Date.now() - last);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
};

let calls = 0;
async function ch(path, tries = 3) {
  for (let t = 0; t < tries; t++) {
    await throttle();
    calls++;
    let r;
    try {
      r = await fetch('https://api.company-information.service.gov.uk' + path, { headers: { Authorization: AUTH } });
    } catch { continue; }
    if (r.status === 429) { await new Promise((res) => setTimeout(res, 20000)); continue; }
    if (r.status === 404) return null;
    if (!r.ok) continue;
    try { return await r.json(); } catch { return null; }
  }
  return null;
}

const norm = (s) => (s || '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
const companyCache = new Map();

async function company(num) {
  if (companyCache.has(num)) return companyCache.get(num);
  const co = await ch('/company/' + num);
  companyCache.set(num, co);
  return co;
}

async function garagesFor(name) {
  const words = norm(name).split(' ').filter((w) => w.length > 1);
  if (words.length < 2) return [];
  const s = await ch('/search/officers?q=' + encodeURIComponent(name) + '&items_per_page=20');
  if (!s || !s.items) return [];

  const out = [];
  let examined = 0;
  for (const o of s.items) {
    if (examined >= 4) break;
    // every word searched for must appear in the officer's name, or this is someone else
    const got = new Set(norm(o.title).split(' '));
    if (!words.every((w) => got.has(w))) continue;
    examined++;
    const ap = await ch(o.links && o.links.self);   // links.self IS the appointments path
    if (!ap || !ap.items) continue;
    for (const a of ap.items) {
      const num = a.appointed_to && a.appointed_to.company_number;
      if (!num) continue;
      const co = await company(num);
      if (!co) continue;
      const sic = co.sic_codes || [];
      if (!sic.some((c) => GARAGE_SIC.has(c))) continue;
      out.push({
        company: co.company_name,
        number: co.company_number,
        status: co.company_status,
        sic: sic.join(','),
        postcode: (co.registered_office_address || {}).postal_code || '',
        town: (co.registered_office_address || {}).locality || '',
        officer: o.title,
        role: a.officer_role || '',
      });
    }
  }
  return out;
}

(async () => {
  const members = JSON.parse(fs.readFileSync(INPUT, 'utf8'));
  const done = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
  const todo = members.filter((m) => !(m.name in done));
  const slice = LIMIT ? todo.slice(0, LIMIT) : todo;

  console.log(`${members.length} members, ${Object.keys(done).length} already done, processing ${slice.length}`);
  const started = Date.now();
  let n = 0, found = 0;

  for (const m of slice) {
    n++;
    try {
      const hits = await garagesFor(m.name);
      done[m.name] = hits;
      if (hits.length) {
        found++;
        console.log(`  ${m.name}  ->  ${[...new Set(hits.map((h) => h.company))].join(' | ')}`);
      }
    } catch (e) {
      console.log(`  ERROR ${m.name}: ${e.message}`);
      done[m.name] = [];
    }
    // checkpoint every name: this run takes hours and must survive being interrupted
    fs.writeFileSync(OUT, JSON.stringify(done, null, 1));
    if (n % 50 === 0) {
      const mins = (Date.now() - started) / 60000;
      const rate = n / mins;
      console.log(`[${n}/${slice.length}] ${found} with a garage | ${calls} API calls | ${rate.toFixed(1)}/min | ~${((slice.length - n) / rate).toFixed(0)} min left`);
    }
  }
  console.log(`\ndone. ${found} of ${slice.length} members matched to a motor-trade company. ${calls} API calls.`);
})();
