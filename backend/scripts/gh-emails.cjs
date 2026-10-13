#!/usr/bin/env node
/*
 * Harvest a contact email from each prospect's own website.
 *
 *   node backend/scripts/gh-emails.cjs prospects.csv --out emails.json [--limit N]
 *
 * Neither Companies House nor Places returns an email, so the website is the only source.
 * Checks the homepage and the usual contact pages, reads mailto: links first (they are
 * unambiguous) and then plain text.
 *
 * Expect a partial yield: plenty of garages use a contact form, put the address in an
 * image, or obfuscate it against exactly this.
 */
const fs = require('fs');

const argv = process.argv.slice(2);
const opt = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const INPUT = argv.find((a) => !a.startsWith('--') && !['--out', '--limit'].includes(argv[argv.indexOf(a) - 1]));
const OUT = opt('--out', 'emails.json');
const LIMIT = Number(opt('--limit', '0'));

const PATHS = ['', '/contact', '/contact-us', '/contact.html', '/about', '/get-in-touch'];
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// Addresses that belong to the website's plumbing rather than the garage.
const JUNK = /(^|@).*(sentry\.|wixpress|wix\.com|example\.|godaddy|squarespace|shopify|cloudflare|schema\.org|w3\.org|jquery|bootstrap|googleapis|\.png$|\.jpg$|\.jpeg$|\.gif$|\.webp$|\.svg$)/i;
const NOREPLY = /^(no-?reply|donotreply|postmaster|abuse|webmaster)@/i;

async function get(url) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 20000);
    const r = await fetch(url, { signal: ctl.signal, redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ReceptionMate prospecting)' } });
    clearTimeout(t);
    if (!r.ok) return null;
    if (!/html/i.test(r.headers.get('content-type') || '')) return null;
    return (await r.text()).slice(0, 600000);
  } catch { return null; }
}

function harvest(html, siteHost) {
  const found = new Map();   // email -> score
  const add = (e, score) => {
    e = e.trim().toLowerCase().replace(/[.,;:)]+$/, '');
    if (JUNK.test(e) || NOREPLY.test(e) || e.length > 70) return;
    const host = e.split('@')[1] || '';
    // an address on the garage's own domain beats a gmail beats anything else
    let s = score;
    if (siteHost && (host === siteHost || siteHost.endsWith('.' + host) || host.endsWith('.' + siteHost))) s += 10;
    else if (/gmail|outlook|hotmail|yahoo|btinternet|icloud|live\./.test(host)) s += 3;
    if (/^(info|enquiries|enquiry|sales|office|admin|hello|service|bookings?)@/.test(e)) s += 2;
    found.set(e, Math.max(found.get(e) || 0, s));
  };
  for (const m of html.matchAll(/mailto:([^"'?>\s]+)/gi)) add(decodeURIComponent(m[1]), 5);
  for (const m of html.matchAll(EMAIL)) add(m[0], 1);
  return found;
}

async function emailsFor(site) {
  let origin, host;
  try {
    const u = new URL(site.startsWith('http') ? site : 'https://' + site);
    origin = u.origin; host = u.hostname.replace(/^www\./, '');
  } catch { return { emails: [], reason: 'bad url' }; }

  const all = new Map();
  const tried = [];
  for (const p of PATHS) {
    if (all.size && p !== '') break;                 // homepage already gave us something
    const url = origin + p;
    tried.push(p || '/');
    const html = await get(url);
    if (!html) continue;
    for (const [e, s] of harvest(html, host)) all.set(e, Math.max(all.get(e) || 0, s));
    if (p === '' && all.size) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  const ranked = [...all.entries()].sort((a, b) => b[1] - a[1]).map(([e]) => e);
  return { emails: ranked, best: ranked[0] || '', checked: tried.length };
}

function readRows(file) {
  const txt = fs.readFileSync(file, 'utf8');
  const rows = []; let cur = [], f = '', q = false;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (q) { if (c === '"') { if (txt[i + 1] === '"') { f += c; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { cur.push(f); f = ''; }
    else if (c === '\n') { cur.push(f); rows.push(cur); cur = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f || cur.length) { cur.push(f); rows.push(cur); }
  const hdr = rows.shift();
  const iName = hdr.findIndex((h) => /^(company|garage|name)$/i.test(h));
  const iSite = hdr.indexOf('website');
  return rows.filter((r) => r.length > 2 && r[iSite]).map((r) => ({ name: r[iName], website: r[iSite] }));
}

(async () => {
  const all = readRows(INPUT);
  const done = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
  let todo = all.filter((r) => !(r.name in done));
  if (LIMIT) todo = todo.slice(0, LIMIT);
  console.log(`${all.length} with a website, ${Object.keys(done).length} already done, doing ${todo.length}`);

  let got = 0;
  for (const r of todo) {
    const res = await emailsFor(r.website);
    done[r.name] = { website: r.website, ...res };
    if (res.best) { got++; console.log(`  ${r.name.slice(0, 34).padEnd(36)} ${res.best}`); }
    fs.writeFileSync(OUT, JSON.stringify(done, null, 1));
  }
  const withEmail = Object.values(done).filter((d) => d.best).length;
  console.log(`\n${got} new; ${withEmail} of ${Object.keys(done).length} checked have an email`);
})().catch((e) => { console.error(e); process.exit(1); });
