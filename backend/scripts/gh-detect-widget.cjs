#!/usr/bin/env node
/*
 * Detect whether a garage's website runs the Garage Hive online booking widget.
 *
 *   node backend/scripts/gh-detect-widget.cjs input.csv --out widget.json [--limit N]
 *
 * input.csv needs a name-ish column and a `website` column (either prospect CSV works).
 *
 * The widget is a script tag:
 *   <script src="https://onlinebooking.garagehive.co.uk/js/iframe/form.js"
 *           id="ghonlinebooking" data-instance="rallysportautomotive">
 *
 * data-instance is the garage's Garage Hive instance -- the same string the portal's
 * "Connect GarageHive" admin action takes -- so a hit pre-fills the integration rather
 * than just answering yes.
 *
 * A miss proves nothing: plenty of Garage Hive garages have a website with no booking
 * page at all. Treat this as positive-only evidence.
 */
const fs = require('fs');

const argv = process.argv.slice(2);
const opt = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const INPUT = argv.find((a) => !a.startsWith('--') && !['--out', '--limit'].includes(argv[argv.indexOf(a) - 1]));
const OUT = opt('--out', 'widget.json');
const LIMIT = Number(opt('--limit', '0'));

const MARKER = /onlinebooking\.garagehive\.co\.uk|ghonlinebooking/i;
const INSTANCE = /data-instance\s*=\s*["']([^"']+)["']/i;

// Where a booking widget lives when it is not on the homepage.
const PATHS = ['', '/booking', '/book-online', '/book', '/online-booking', '/book-a-service', '/mot-booking', '/contact'];

async function get(url) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 20000);
    const r = await fetch(url, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ReceptionMate prospecting)' },
    });
    clearTimeout(t);
    if (!r.ok) return null;
    const ct = r.headers.get('content-type') || '';
    if (!/html/i.test(ct)) return null;
    return (await r.text()).slice(0, 600000);
  } catch {
    return null;
  }
}

function originOf(site) {
  try {
    const u = new URL(site.startsWith('http') ? site : 'https://' + site);
    return u.origin;
  } catch {
    return null;
  }
}

async function check(site) {
  const origin = originOf(site);
  if (!origin) return { uses: false, reason: 'bad url' };

  const home = await get(origin + '/');
  if (home === null) return { uses: false, reason: 'unreachable' };
  if (MARKER.test(home)) {
    const m = home.match(INSTANCE);
    return { uses: true, instance: m ? m[1] : '', where: origin + '/' };
  }

  // Follow the site's own booking links before guessing paths -- cheaper and more accurate.
  const links = new Set();
  for (const m of home.matchAll(/href=["']([^"']*(?:book|appoint)[^"']*)["']/gi)) {
    try { links.add(new URL(m[1], origin + '/').href); } catch { /* skip */ }
  }
  for (const p of PATHS.slice(1)) links.add(origin + p);

  let tried = 0;
  for (const url of links) {
    if (tried++ >= 6) break;
    if (!url.startsWith(origin)) continue;
    await new Promise((r) => setTimeout(r, 400));
    const html = await get(url);
    if (html && MARKER.test(html)) {
      const m = html.match(INSTANCE);
      return { uses: true, instance: m ? m[1] : '', where: url };
    }
  }
  return { uses: false, reason: 'no widget found', checked: tried + 1 };
}

function readRows(file) {
  const txt = fs.readFileSync(file, 'utf8');
  if (txt.trim().startsWith('[')) return JSON.parse(txt);
  // minimal CSV reader -- fields may contain commas and escaped quotes
  const rows = []; let cur = [], f = '', q = false;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (q) {
      if (c === '"') { if (txt[i + 1] === '"') { f += c; i++; } else q = false; }
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { cur.push(f); f = ''; }
    else if (c === '\n') { cur.push(f); rows.push(cur); cur = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f || cur.length) { cur.push(f); rows.push(cur); }
  const hdr = rows.shift();
  const iName = hdr.findIndex((h) => /^(company|garage|name)$/i.test(h));
  const iSite = hdr.indexOf('website');
  return rows.filter((r) => r.length > 1 && r[iSite]).map((r) => ({ name: r[iName], website: r[iSite] }));
}

(async () => {
  const all = readRows(INPUT).filter((r) => r.website);
  const done = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
  let todo = all.filter((r) => !(r.name in done));
  if (LIMIT) todo = todo.slice(0, LIMIT);

  console.log(`${all.length} with a website, ${Object.keys(done).length} already checked, doing ${todo.length}`);
  let hits = 0;
  for (const r of todo) {
    const res = await check(r.website);
    done[r.name] = { website: r.website, ...res };
    if (res.uses) { hits++; console.log(`  GARAGE HIVE  ${r.name}  instance="${res.instance}"`); }
    fs.writeFileSync(OUT, JSON.stringify(done, null, 1));
  }
  const confirmed = Object.values(done).filter((d) => d.uses);
  console.log(`\n${hits} new hit(s); ${confirmed.length} of ${Object.keys(done).length} checked run the GH booking widget`);
})().catch((e) => { console.error(e); process.exit(1); });
