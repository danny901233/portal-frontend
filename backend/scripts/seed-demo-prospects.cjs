#!/usr/bin/env node
/*
 * Seed the demo-prospect pilot from the shortlist + the website enrichment pass.
 *
 *   node backend/scripts/seed-demo-prospects.cjs --csv <shortlist.csv> [--enriched <enriched.json>] [--apply]
 *
 * Dry run unless --apply, like the other prospecting scripts.
 *
 * Creates ONE DemoProspect row per garage. Deliberately no Garage row and no AgentConfiguration:
 * the agent reads its runtime config from DynamoDB keyed on DemoProspect.agentId, so a prospect
 * never shows up in the garage pickers, dashboards, billing, the arrears sweep or the watchdog's
 * routing audit. The config itself is built lazily, on their first click, by
 * POST /api/public/demo-prospect/:token.
 *
 * Shortlist CSV columns: contactId,name,email,website,status
 * Enrichment JSON (optional): [{ contactId, siteOk, postcode, phone, hoursLines }]  — used only
 * to skip garages whose website did not resolve, since a dead site means a generic-sounding demo.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); } catch { /* env may already be set */ }

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const APPLY = flag('--apply');
const CSV = opt('--csv');
const ENRICHED = opt('--enriched');
// places.json from the Places enrichment pass: [{ contactId, placeId, ... }]. Carried onto the
// row so the build can fetch the garage's real address and phone from Google once and cache them.
// Without a placeId the agent has no address at all, and told a prospect asking where they were
// based that it would pass the question to the team.
const PLACES = opt('--places');
const DAYS = Number(opt('--days', '30'));
const LIMIT = Number(opt('--limit', '500'));
const REQUIRE_SITE = !flag('--allow-dead-sites');

if (!CSV) { console.error('Pass --csv <shortlist.csv>'); process.exit(1); }

/** Same tidy-up the route applies, kept in step with toSpokenName() in demo-prospect.ts. */
const SPEAK_AS_LETTERS = new Set(['MOT', 'MOTS', 'HGV', 'LPG', 'DPF', 'ECU', 'PSV', 'LCV', 'TPMS', 'AC', 'EV', 'BMW', 'VW', 'MG', 'JCB', 'RAC', 'AA', 'UK']);
const SMALL_WORDS = new Set(['of', 'and', 'the', 'on', 'at', 'in', 'for', 'to', 'a']);
const titleCaseForSpeech = (input) => input.split(' ').filter(Boolean).map((word, i) => {
  const bare = word.replace(/[^A-Za-z0-9]/g, '');
  if (!bare) return word;
  if (SPEAK_AS_LETTERS.has(bare.toUpperCase())) return word.toUpperCase();
  if (bare.length === 1) return word.toUpperCase();
  if (i > 0 && SMALL_WORDS.has(bare.toLowerCase())) return word.toLowerCase();
  return word.toLowerCase().replace(/[a-z]/, (ch) => ch.toUpperCase());
}).join(' ');
const toSpokenName = (raw) => {
  let s = (raw || '').trim();
  s = s.split(/\s+[-–]\s+|,/)[0];
  s = s.replace(/\s*\b(ltd|limited|llp|plc)\b\.?\s*$/i, '');
  s = s.replace(/&/g, ' and ').replace(/\s+/g, ' ').trim();
  return titleCaseForSpeech(s) || raw;
};

function cols(line) {
  const out = []; let cur = '', q = false;
  for (const ch of line) {
    if (ch === '"') { q = !q; continue; }
    if (ch === ',' && !q) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur); return out;
}

const rows = fs.readFileSync(CSV, 'utf8').trim().split(/\r?\n/).slice(1)
  .map(cols).filter((r) => r.length >= 4)
  .map((r) => ({ contactId: r[0], name: r[1], email: r[2], website: r[3], status: r[4] || '' }));

let enrich = new Map();
if (ENRICHED && fs.existsSync(ENRICHED)) {
  for (const e of JSON.parse(fs.readFileSync(ENRICHED, 'utf8'))) enrich.set(e.contactId, e);
  console.log(`enrichment loaded for ${enrich.size} contacts`);
}

const places = new Map();
if (PLACES && fs.existsSync(PLACES)) {
  for (const p of JSON.parse(fs.readFileSync(PLACES, 'utf8'))) {
    if (p && p.contactId && p.placeId) places.set(p.contactId, p.placeId);
  }
  console.log(`place ids loaded for ${places.size} contacts`);
}

const main = async () => {
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();

  // 5-digit codes: short enough for a dialler to send as tones in a tel: dial string. Collisions
  // are checked against the database rather than assumed away, because the code is a unique key
  // and a clash would hand one prospect another prospect's agent.
  const used = new Set((await prisma.demoProspect.findMany({ select: { code: true } })).map((p) => p.code));
  const newCode = () => {
    for (let i = 0; i < 500; i += 1) {
      const c = String(crypto.randomInt(10000, 99999));
      if (!used.has(c)) { used.add(c); return c; }
    }
    throw new Error('ran out of unused 5-digit codes');
  };

  // The URL is their own name plus four hex characters. The name is the whole point — a garage
  // owner can see the link is theirs before clicking, which an opaque token cannot do. The suffix
  // is not decoration: a first visit BUILDS the agent, so a guessable URL would let anyone spend a
  // website scrape and an OpenAI call per guess, and tell a 200 from a 404 to enumerate the list.
  // Names also collide — 29 pairs across the 6,803 CRM contacts.
  const usedSlugs = new Set(
    (await prisma.demoProspect.findMany({ select: { slug: true } })).map((p) => p.slug),
  );
  const newSlug = (spokenName) => {
    const base = (spokenName || 'garage')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/g, '') || 'garage';
    // 64 bits of CSPRNG. Four hex characters looked tidier and was wrong: 16 bits is ~65k
    // guesses, which is minutes of scripting, and a first visit BUILDS the agent — so a guesser
    // spends our scrape and OpenAI budget, and telling a 200 from a 404 enumerates the prospect
    // list. The garage's name still leads the URL, which is where all the persuasion lives.
    for (let i = 0; i < 500; i += 1) {
      const candidate = `${base}-${crypto.randomBytes(8).toString('hex')}`;
      if (!usedSlugs.has(candidate)) { usedSlugs.add(candidate); return candidate; }
    }
    throw new Error(`could not find a free slug for ${spokenName}`);
  };

  const expiresAt = new Date(Date.now() + DAYS * 24 * 60 * 60 * 1000);
  let created = 0, skippedExisting = 0, skippedDeadSite = 0, skippedNoSite = 0;
  const plan = [];

  for (const r of rows) {
    if (plan.length >= LIMIT) break;
    if (!r.website) { skippedNoSite += 1; continue; }
    const e = enrich.get(r.contactId);
    if (REQUIRE_SITE && e && e.siteOk === false) { skippedDeadSite += 1; continue; }

    const existing = await prisma.demoProspect.findFirst({
      where: { OR: [{ contactId: r.contactId }, ...(r.email ? [{ email: r.email }] : [])] },
      select: { id: true },
    });
    if (existing) { skippedExisting += 1; continue; }

    plan.push({
      slug: newSlug(toSpokenName(r.name)),
      code: newCode(),
      businessName: r.name,
      spokenName: toSpokenName(r.name),
      websiteUrl: r.website,
      email: r.email || null,
      contactId: r.contactId || null,
      placeId: places.get(r.contactId) || null,
      expiresAt,
    });
  }

  console.log(`\nshortlist rows      ${rows.length}`);
  console.log(`already seeded      ${skippedExisting}`);
  console.log(`website did not resolve (skipped) ${skippedDeadSite}`);
  console.log(`no website          ${skippedNoSite}`);
  console.log(`TO CREATE           ${plan.length}`);
  console.log('\nfirst 5:');
  plan.slice(0, 5).forEach((p) => console.log(`  ${p.spokenName.padEnd(34)} ${p.websiteUrl.padEnd(34)} code ${p.code}  /try/${p.slug}`));

  if (!APPLY) { console.log('\nDRY RUN — pass --apply to write.'); await prisma.$disconnect(); return; }

  for (const p of plan) {
    await prisma.demoProspect.create({ data: p });
    created += 1;
  }
  console.log(`\ncreated ${created}`);

  // The phone leg needs every prospect's SIP destination on the inbound trunk, because LiveKit
  // matches a trunk on the called number. Miss this and the tel: link silently lands the caller on
  // the GENERIC demo — the failure that wasted three test calls. Written out here so it is part of
  // seeding rather than something a person has to remember; `lk` holds the project credentials, so
  // the command itself has to be run from a machine that has them.
  const trunkPath = path.join(path.dirname(CSV), 'trunk-numbers.txt');
  const everyProspect = await prisma.demoProspect.findMany({
    select: { agentId: true }, orderBy: { agentId: 'asc' },
  });
  fs.writeFileSync(trunkPath, everyProspect.map((p) => `garage-${p.agentId}`).join(','));
  console.log(`\nSIP trunk — run this or the phone links go to the generic demo:`);
  console.log(`  lk sip inbound update --id ST_Dos84B2iZYgt --numbers "$(cat ${trunkPath})"`);
  console.log(`  (${everyProspect.length} destinations)`);

  const outPath = path.join(path.dirname(CSV), 'demo-links.csv');
  fs.writeFileSync(outPath, 'contactId,email,name,code,url\n' + plan
    .map((p) => [p.contactId, p.email, '"' + p.spokenName + '"', p.code,
      `${process.env.PORTAL_URL || 'https://portal.receptionmate.co.uk'}/try/${p.slug}`].join(','))
    .join('\n'));
  console.log(`links for the mail merge -> ${outPath}`);
  await prisma.$disconnect();
};

main().catch((e) => { console.error(e); process.exit(1); });
