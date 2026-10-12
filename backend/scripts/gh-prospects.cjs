#!/usr/bin/env node
/*
 * Turn Garage Hive Community "welcome" posts into a deduped, enriched prospect list.
 *
 *   node backend/scripts/gh-prospects.cjs posts.json [--csv out.csv] [--review] [--push-highlevel]
 *
 * posts.json is whatever gh-welcome-extract.js printed: [{ author, body }, ...].
 * Plain strings work too, so you can hand-paste a list of names.
 *
 * Stages: classify -> name -> dedupe against the portal -> enrich via Places -> CSV.
 * Every stage degrades rather than throws: no Places key just means no phone numbers,
 * and the push to HighLevel is a dry run unless you explicitly ask for it.
 */
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

// Prisma finds DATABASE_URL on its own, but the Places and HighLevel keys are read
// straight off process.env -- so load the backend .env when it is there. Optional, so
// the script still runs from a checkout that has no dotenv installed.
try { require('dotenv').config(); } catch { /* fine -- env may already be set */ }

// ---------------------------------------------------------------- args

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const inputPath = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--csv');

if (!inputPath) {
  console.error('usage: node backend/scripts/gh-prospects.cjs <posts.json> [--csv out.csv] [--review] [--push-highlevel]');
  process.exit(1);
}

const REVIEW = flag('--review');
const PUSH = flag('--push-highlevel');
const CSV_PATH = opt('--csv');

// ---------------------------------------------------------------- classify

// A `welcome` search also returns site-visit write-ups for long-standing customers
// ("these guys have been on Garage Hive since 2019"). Those are not new garages, and
// treating them as prospects would put existing GH users into the pipeline.
const WELCOME_RE = /\bwelcome\b/i;
const EXISTING_RE = /\b(?:been (?:on|with|using)|on)\s+garage\s*hive\s+(?:since|for)\b|\bsince\s+20[01]\d\b/i;

// ---------------------------------------------------------------- name extraction

// Deliberately heuristic. The posts are written by six different people in free prose,
// so this gets most of them and --review exists for the rest.
const AT_RE = /\b(?:the\s+)?(?:guys|team|crew|folks|gang|lads)\s+at\s+/i;
const LEAD_STRIPS = [
  /^\s*(?:back\s+)?to\s+/i,
  /^\s*the\s+/i,
  /^\s*garage\s*hive\s+/i,
  /^\s*gh\b\s*/i,
  /^\s*our\s+(?:first|newest|latest|next)\s+/i,
  /^\s*(?:a|the)?\s*(?:new|newest)?\s*garage\s+to\s+/i,
  /^\s*(?:team|crew|gang)\s+/i,
  /^\s*(?:for|another|and|with|at)\s+/i,
  /^\s*(?:family|community)\s+/i,
  /^\s*our\s+newbies\s*/i,
  /^\s*this\s+week\s*/i,
  /^\s*on\s+board\s*/i,
  /^\s*newest\s+(?:member|members)\s*/i,
];
const CUT_RE = /[,.!?;:—–(]|\s+based\s+in\b|\s+near\b|\s+down\s+south\b|\s+up\s+in\b|\s+over\s+in\b|\s+in\b|\s+who\b|\s+officially\b|\s+to\s+the\s+garage\s*hive\b|\s+has\s+|\s+have\s+/i;

function extractName(body) {
  const w = body.search(WELCOME_RE);
  if (w < 0) return null;
  let rest = body.slice(w + 'welcome'.length);

  // "welcome to Connor and the team at Connor Wilson Vehicles" -- the garage is what
  // follows "team at", not the person being greeted first.
  const firstStop = rest.search(/[.!?]/);
  const head = firstStop >= 0 ? rest.slice(0, firstStop) : rest;
  const at = head.match(AT_RE);
  if (at) rest = rest.slice(rest.indexOf(at[0]) + at[0].length);

  // Peel connectives off the front until nothing matches: "to the Garage Hive family to X".
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 12) {
    changed = false;
    for (const re of LEAD_STRIPS) {
      if (re.test(rest)) { rest = rest.replace(re, ''); changed = true; }
    }
  }

  const cut = rest.search(CUT_RE);
  let name = (cut >= 0 ? rest.slice(0, cut) : rest).trim();

  // Only treat " and " as the end of the name when what precedes it is already a
  // plausible business name. "I and K Motors" keeps its ands; "Ramsey Hill Garage and
  // Frazer Wood" drops the owner.
  const andAt = name.search(/\s+\band\b\s+/i);
  if (andAt > 0 && name.slice(0, andAt).trim().split(/\s+/).length >= 2) {
    name = name.slice(0, andAt).trim();
  }
  name = name.replace(/\s+team$/i, '').replace(/^["'`]+|["'`]+$/g, '').trim();

  // "Alford Auto Station this week" -- prose that trails the name.
  name = name.replace(/\s+(?:this\s+(?:week|morning|afternoon)|today|yesterday|now)$/i, '').trim();

  let parts = name.split(/\s+/);

  // Once we have a plausible name, a lowercase word or a digit means the sentence has
  // moved on: "Japex Motors Awesome 3 day onsite go live" -> "Japex Motors Awesome".
  for (let i = 2; i < parts.length; i++) {
    if (/^[a-z]/.test(parts[i]) || /^\d/.test(parts[i])) { parts = parts.slice(0, i); break; }
  }

  // A trailing pair of bare capitalised words is almost always the owner, not the
  // business: "DNA Vehicle Services Dean Andrew".
  const BIZ = /^(ltd|limited|garage|garages|motors|motor|autos|auto|automotive|services|service|centre|center|tyres|tyre|workshops|cars|commercials|engineering|group|co|branch|son|sons)$/i;
  while (parts.length >= 4 && /^[A-Z][a-z]+$/.test(parts[parts.length - 1]) && !BIZ.test(parts[parts.length - 1])
         && /^[A-Z][a-z]+$/.test(parts[parts.length - 2]) && !BIZ.test(parts[parts.length - 2])) {
    parts = parts.slice(0, -2);
  }

  name = parts.join(' ').replace(/[\s,&-]+$/, '').trim();

  // Words the prose leaves behind when the name sits somewhere we did not find it.
  const JUNK = /^(newbies?|community|family|thanks?|everyone|all|us|them|guys|team|hive|garage hive)$/i;
  if (JUNK.test(name)) return null;

  const lc = name.toLowerCase();
  const confidence = /\b(?:welcome|week|onsite|go live|pleasure)\b/.test(lc) || parts.length > 5 ? 'low' : 'high';
  return name.length >= 3 && name.length <= 60 ? { name, confidence } : null;
}

// ---------------------------------------------------------------- matching

const SUFFIXES = /\b(ltd|limited|llp|plc|uk|co|company|the)\b/g;

// Nearly every garage name contains some of these, so on their own they are not evidence
// that two names are the same business -- "Marieston Service Centre" and "Ecotest MOT &
// Service Centre" share two of three words and are unrelated.
const GENERIC = new Set([
  'garage', 'garages', 'service', 'services', 'centre', 'center', 'motors', 'motor',
  'auto', 'autos', 'automotive', 'mot', 'car', 'cars', 'vehicle', 'vehicles', 'repair',
  'repairs', 'tyre', 'tyres', 'performance', 'engineering', 'autocentre', 'autocentres',
  'solutions', 'group', 'specialist', 'specialists', 'commercials', 'station',
  'and', 'to', 'at', 'with', 'for', 'from', 'this', 'that', 'all', 'as', 'they',
]);
const distinctive = (s) => new Set([...tokens(s)].filter((t) => !GENERIC.has(t) && t.length > 1));
const norm = (s) => (s || '').toLowerCase().replace(/['\u2019]/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(SUFFIXES, ' ').replace(/\s+/g, ' ').trim();
const tokens = (s) => new Set(norm(s).split(' ').filter(Boolean));

function jaccard(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m || !n) return Math.max(m, n);
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// "VGS Performance" vs the portal's "VWGS Performance" shares only one token, so token
// overlap alone misses it -- edit distance on the squashed string is what catches a typo
// or a dropped letter in a trading name.
function editRatio(a, b) {
  const A = norm(a).replace(/\s/g, ''), B = norm(b).replace(/\s/g, '');
  if (!A || !B) return 0;
  return 1 - levenshtein(A, B) / Math.max(A.length, B.length);
}

function bestMatch(name, known) {
  let best = null;
  for (const g of known) {
    const nA = norm(name), nB = norm(g.name);
    if (!nA || !nB) continue;
    let score, how;
    if (nA === nB) { score = 1; how = 'exact'; }
    else if (nA.length > 6 && nB.length > 6 && (nA.includes(nB) || nB.includes(nA))) { score = 0.95; how = 'contains'; }
    else {
      const j = jaccard(name, g.name), e = editRatio(name, g.name);
      score = Math.max(j, e);
      how = j >= e ? 'tokens' : 'edit';
    }
    // Require something distinctive in common before trusting a partial match; without
    // that, only a near-identical spelling counts (so VGS vs VWGS still surfaces).
    if (how !== 'exact' && how !== 'contains') {
      const dA = distinctive(name), dB = distinctive(g.name);
      let shared = false;
      for (const t of dA) if (dB.has(t)) shared = true;
      if (!shared && editRatio(name, g.name) < 0.85) score = 0;
    }
    if (!best || score > best.score) best = { garage: g.name, source: g.source, score, how };
  }
  // A zero score is "no match at all", not "matched the first garage on the list".
  return best && best.score > 0 ? best : null;
}

const MIN_PLAUSIBLE_GARAGES = 20;

const MATCH_SURE = 0.9;   // treat as already a customer
const MATCH_MAYBE = 0.62; // flag for human eyes

// ---------------------------------------------------------------- places enrichment

const PLACES_KEY =
  process.env.GOOGLE_PLACES_API_KEY ||
  process.env.GOOGLE_MAPS_API_KEY ||
  process.env.PUBLIC_GOOGLE_MAPS_API_KEY ||
  '';

async function enrich(name, hint) {
  if (!PLACES_KEY) return null;
  try {
    const resp = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': PLACES_KEY,
        'X-Goog-FieldMask':
          'places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri',
      },
      body: JSON.stringify({ textQuery: [name, hint, 'UK'].filter(Boolean).join(' '), maxResultCount: 1 }),
    });
    if (!resp.ok) return null;
    const j = await resp.json();
    const p = (j.places || [])[0];
    if (!p) return null;
    const got = p.displayName?.text || '';
    // Google legitimately returns a fuller trading name than the post used ("AFS Repair"
    // -> "AFS Auto Repair Centre"), so overall similarity is the wrong test -- it threw
    // away good matches. What must hold is that the distinctive words we searched for
    // actually appear in the result: that keeps the fuller names and still rejects
    // "Nick and" -> "St Nic's Church".
    const want = distinctive(name), gotTokens = tokens(got);
    const allPresent = want.size > 0 && [...want].every((t) => gotTokens.has(t));
    const resembles =
      allPresent ||
      editRatio(name, got) >= 0.6 ||
      norm(got).includes(norm(name)) ||
      norm(name).includes(norm(got)) ||
      (want.size === 0 && jaccard(name, got) >= 0.4);
    if (!resembles) return { rejected: got };
    return {
      placeId: p.id || '',
      placeName: p.displayName?.text || '',
      address: p.formattedAddress || '',
      phone: p.nationalPhoneNumber || '',
      website: p.websiteUri || '',
    };
  } catch {
    return null;
  }
}

// Posts name a town often enough to disambiguate "Classic Collective" from the rest of
// the internet, so pull it back out of the prose as a search hint.
function locationHint(body) {
  const m = body.match(/\b(?:based in|near|up in|over in|down in|in)\s+([A-Z][A-Za-z'’-]+(?:[-\s][A-Z][A-Za-z'’-]+){0,1})/);
  return m ? m[1].trim() : '';
}

// ---------------------------------------------------------------- existing garages

/*
 * Dedupe is the whole point, so an empty or unreachable garage list must stop the run.
 * Local .env points DATABASE_URL at localhost, which is why this needs --garages (a text
 * or JSON list of current names) whenever you are not running on the box.
 */
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
    // A local dev database with a handful of rows passes an "is it empty" check while
    // making dedupe worthless -- every real customer still reads as a new prospect.
    if (rows.length < MIN_PLAUSIBLE_GARAGES && !flag('--allow-small-db')) {
      console.error(`\nOnly ${rows.length} garages in this database -- that looks like a dev copy, not production.`);
      console.error('Deduping against it would mark existing customers as new prospects.');
      console.error('Run on the EC2 box, pass --garages <file>, or --allow-small-db if you meant it.\n');
      process.exit(1);
    }
    console.log(`loaded ${rows.length} existing garages from the database`);
    return rows.map((r) => ({ name: r.name, source: 'portal' }));
  } catch (e) {
    console.error(`\nCannot read the garage list: ${e.message || e}`);
    console.error('Without it every prospect would look new, so stopping here.');
    console.error('Run on the EC2 box, or pass --garages <file> with the current names.\n');
    process.exit(1);
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

// ---------------------------------------------------------------- highlevel contacts

/*
 * A garage already sitting in the Onboarding pipeline is not a new prospect, so the
 * portal's Garage table is only half the dedupe -- anyone previously contacted lives in
 * HighLevel instead. Returns null (not an empty list) when it cannot look, so the caller
 * can say so loudly rather than quietly treating known leads as fresh.
 */
async function loadHighLevel() {
  const file = opt('--hl-contacts');
  if (file) {
    const txt = fs.readFileSync(file, 'utf8').trim();
    let names;
    if (txt.startsWith('[')) {
      names = JSON.parse(txt).map((c) => (typeof c === 'string' ? c : c.companyName || c.name));
    } else {
      // tolerate a CSV export: take the first column, drop a header row
      const lines = txt.split('\n').filter(Boolean);
      if (/name/i.test(lines[0])) lines.shift();
      names = lines.map((l) => (l.match(/^\s*"([^"]*)"/) || [, l.split(',')[0]])[1]);
    }
    const clean = [...new Set(names.map((n) => String(n || '').trim()).filter(Boolean))];
    console.log(`loaded ${clean.length} HighLevel contacts from ${file}`);
    return clean.map((name) => ({ name, source: 'highlevel' }));
  }

  const key = process.env.GHL_API_KEY, loc = process.env.GHL_LOCATION_ID;
  if (!key || !loc) return null;

  const headers = { Authorization: `Bearer ${key}`, Version: '2021-07-28', 'Content-Type': 'application/json' };
  const names = new Set();
  try {
    let page = 1;
    for (; page <= 40; page++) {
      const res = await fetch('https://services.leadconnectorhq.com/contacts/search', {
        method: 'POST',
        headers,
        body: JSON.stringify({ locationId: loc, page, pageLimit: 100 }),
      });
      if (!res.ok) throw new Error(`contacts/search ${res.status}`);
      const j = await res.json();
      const batch = j.contacts || [];
      for (const c of batch) {
        const n = c.companyName || c.name || [c.firstName, c.lastName].filter(Boolean).join(' ');
        if (n) names.add(String(n).trim());
      }
      if (batch.length < 100) break;
    }
    console.log(`loaded ${names.size} HighLevel contacts from the API`);
    return [...names].map((name) => ({ name, source: 'highlevel' }));
  } catch (e) {
    console.error(`HighLevel lookup failed (${e.message}) -- continuing without CRM dedupe`);
    return null;
  }
}

// ---------------------------------------------------------------- main

(async () => {
  const raw = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const posts = (Array.isArray(raw) ? raw : [raw]).map((p) =>
    typeof p === 'string' ? { author: '', body: p } : { author: p.author || '', body: p.body || '', year: p.year || '' },
  );

  const skippedExisting = [];
  const unparsed = [];
  const candidates = [];

  for (const p of posts) {
    if (!WELCOME_RE.test(p.body)) continue;
    if (EXISTING_RE.test(p.body)) { skippedExisting.push(p); continue; }
    const parsed = extractName(p.body);
    if (!parsed) { unparsed.push(p); continue; }
    candidates.push({ name: parsed.name, confidence: parsed.confidence, author: p.author, body: p.body, year: p.year, hint: locationHint(p.body) });
  }

  // Collapse repeats of the same garage across multiple posts.
  const byName = new Map();
  for (const c of candidates) if (!byName.has(norm(c.name))) byName.set(norm(c.name), c);
  const uniq = Array.from(byName.values());

  const garages = await loadGarages();
  const hl = await loadHighLevel();
  const known = [...garages, ...(hl || [])];

  const rows = [];
  for (const c of uniq) {
    const m = bestMatch(c.name, known) || { garage: '', source: '', score: 0, how: '' };
    // Only an exact or containment match is allowed to retire a prospect outright. A
    // near-identical spelling goes to 'check', because silently dropping a real new
    // garage costs more than asking Dan to glance at one line.
    const sure = m.score >= MATCH_SURE && (m.how === 'exact' || m.how === 'contains');
    const status = sure ? 'existing' : m.score >= MATCH_MAYBE ? 'check' : 'new';
    const found = status === 'existing' ? null : await enrich(c.name, c.hint);
    const place = found && !found.rejected ? found : null;
    rows.push({ ...c, match: m, status, place, rejectedPlace: found && found.rejected ? found.rejected : '' });
  }

  // ------------------------------------------------------------ report

  const pad = (s, n) => String(s || '').slice(0, n).padEnd(n);
  rows.sort((a, b) => String(b.year || '').localeCompare(String(a.year || '')));
  const newOnes = rows.filter((r) => r.status === 'new');
  const checks = rows.filter((r) => r.status === 'check');
  const existing = rows.filter((r) => r.status === 'existing');

  console.log(`\nparsed ${posts.length} posts -> ${uniq.length} garages`);
  console.log(`  new ${newOnes.length} | check ${checks.length} | existing ${existing.length}`);
  if (skippedExisting.length) console.log(`  skipped ${skippedExisting.length} non-welcome post(s) (existing GH customer visits)`);
  if (unparsed.length) console.log(`  could not read a name from ${unparsed.length} post(s) -- run with --review`);
  const lowConf = rows.filter((r) => r.confidence === 'low');
  if (lowConf.length) console.log(`  ${lowConf.length} name(s) parsed with low confidence -- marked * below`);
  if (!PLACES_KEY) console.log('  NOTE: no GOOGLE_PLACES_API_KEY in env -- phone/website columns are empty');
  const rejected = rows.filter((r) => r.rejectedPlace);
  if (rejected.length) console.log(`  ${rejected.length} Places result(s) rejected as a different business -- see rejected_place in the CSV`);
  if (!hl) console.log('  WARNING: HighLevel not checked -- set GHL_API_KEY/GHL_LOCATION_ID or pass --hl-contacts.\n           Garages already in the pipeline will show as new.');

  console.log(`\n${pad('GARAGE', 30)} ${pad('YR', 5)}${pad('TOWN', 16)} ${pad('PHONE', 15)} WEBSITE`);
  for (const r of newOnes) {
    const p = r.place || {};
    console.log(`${r.confidence === 'low' ? '*' : ' '}${pad(r.name, 29)} ${pad(r.year, 5)}${pad(r.hint, 16)} ${pad(p.phone, 15)} ${(p.website || '').slice(0, 40)}`);
  }

  if (checks.length) {
    console.log('\nPOSSIBLE EXISTING CUSTOMERS -- confirm by hand:');
    for (const r of checks) {
      console.log(`  ${pad(r.name, 30)} ~ ${pad(r.match.garage, 30)} [${r.match.source}] (${r.match.how} ${r.match.score.toFixed(2)})`);
    }
  }
  if (existing.length) {
    console.log('\nALREADY KNOWN (customer, or already in the pipeline):');
    for (const r of existing) console.log(`  ${pad(r.name, 30)} -> ${pad(r.match.garage, 30)} [${r.match.source}]`);
  }

  if (REVIEW) {
    console.log('\n--- review: name vs source prose ---');
    for (const r of rows) console.log(`\n[${r.status}] ${r.name}\n    ${r.body.slice(0, 180)}`);
    for (const p of unparsed) console.log(`\n[UNPARSED] ${p.body.slice(0, 180)}`);
  }

  // ------------------------------------------------------------ csv

  if (CSV_PATH) {
    const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const lines = [['garage', 'town', 'phone', 'website', 'address', 'year', 'status', 'matched_to', 'matched_in', 'score', 'confidence', 'place_name', 'rejected_place', 'source_post'].join(',')];
    for (const r of rows) {
      const p = r.place || {};
      lines.push([r.name, r.hint, p.phone, p.website, p.address, r.year, r.status, r.match.garage, r.match.source, r.match.score.toFixed(2), r.confidence, p.placeName, r.rejectedPlace, r.body.slice(0, 300)].map(esc).join(','));
    }
    fs.mkdirSync(path.dirname(path.resolve(CSV_PATH)), { recursive: true });
    fs.writeFileSync(CSV_PATH, lines.join('\n'));
    console.log(`\nwrote ${rows.length} rows -> ${CSV_PATH}`);
  }

  // ------------------------------------------------------------ highlevel

  // Writing into the live CRM is the one irreversible step here, so it never happens
  // without the explicit flag -- the default is to print what it would have sent.
  if (!PUSH) {
    console.log(`\n(dry run) would push ${newOnes.length} new garage(s) to HighLevel. Re-run with --push-highlevel to do it.`);
  } else {
    const key = process.env.GHL_API_KEY;
    const loc = process.env.GHL_LOCATION_ID;
    const pipelineId = opt('--pipeline', process.env.GHL_PIPELINE_ID);
    // Onboarding Newest -> "Cold Lead". Not in .env (GHL_LEAD_STAGE_ID is the warmer
    // "Enquiry Received" stage), so it is passed explicitly.
    const stageId = opt('--stage', '37b4585c-465f-4861-b1dd-a0a830f46243');
    const tag = opt('--tag', 'gh-community-welcome');

    if (!key || !loc) {
      console.log('\n--push-highlevel given but GHL_API_KEY / GHL_LOCATION_ID are not set -- nothing pushed.');
    } else if (!pipelineId || !stageId) {
      console.log('\nNo pipeline/stage to push into -- pass --pipeline and --stage.');
    } else {
      const headers = { Authorization: `Bearer ${key}`, Version: '2021-07-28', 'Content-Type': 'application/json' };
      // A canary run (--limit 2) before committing 100+ records to a live CRM.
      const limit = Number(opt('--limit', '0')) || newOnes.length;
      const todo = newOnes.slice(0, limit);
      console.log(`\npushing ${todo.length} of ${newOnes.length} to pipeline ${pipelineId} stage ${stageId}, tagged "${tag}"`);

      let ok = 0, failed = 0;
      for (const r of todo) {
        const pl = r.place || {};
        try {
          const hasIdentifier = Boolean(pl.phone);
          const cRes = await fetch(
            hasIdentifier
              ? 'https://services.leadconnectorhq.com/contacts/upsert'
              : 'https://services.leadconnectorhq.com/contacts/',
            {
            method: 'POST',
            headers,
            // HighLevel rejects a contact carrying neither phone/email nor
            // firstName+lastName, which is every garage Places could not find a number
            // for. Split the trading name the same way upsertContact does in
            // services/highlevel.ts so those still land.
            body: JSON.stringify({
              locationId: loc,
              name: r.name,
              firstName: r.name.trim().split(/\s+/)[0] || r.name,
              lastName: r.name.trim().split(/\s+/).slice(1).join(' ') || '(garage)',
              companyName: r.name,
              ...(pl.phone ? { phone: pl.phone } : {}),
              ...(pl.website ? { website: pl.website } : {}),
              ...(pl.address ? { address1: pl.address } : {}),
              ...(r.hint ? { city: r.hint } : {}),
              source: 'GH Community welcome post',
              tags: [tag, 'cold-prospect'],
            }),
          });
          if (!cRes.ok) throw new Error(`contact ${cRes.status} ${(await cRes.text()).slice(0, 120)}`);
          const cJson = await cRes.json();
          const contactId = cJson.contact?.id || cJson.id;
          if (!contactId) throw new Error('no contact id returned');

          const existingRes = await fetch(
            `https://services.leadconnectorhq.com/opportunities/search?location_id=${loc}&contact_id=${contactId}&status=open&limit=1`,
            { headers },
          );
          if (existingRes.ok) {
            const ex = await existingRes.json();
            if ((ex.opportunities || []).length) {
              ok++;
              console.log(`  exists  ${r.name} (open opportunity already)`);
              continue;
            }
          }

          const oRes = await fetch('https://services.leadconnectorhq.com/opportunities/', {
            method: 'POST',
            headers,
            body: JSON.stringify({
              pipelineId,
              pipelineStageId: stageId,
              locationId: loc,
              contactId,
              name: r.name,
              status: 'open',
            }),
          });
          if (!oRes.ok) throw new Error(`opportunity ${oRes.status} ${(await oRes.text()).slice(0, 120)}`);
          ok++;
          console.log(`  ok      ${r.name}`);
        } catch (e) {
          failed++;
          console.log(`  FAILED  ${r.name} -- ${e.message}`);
        }
      }
      console.log(`\npushed ${ok}, failed ${failed}`);
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });
