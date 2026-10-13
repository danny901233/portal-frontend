#!/usr/bin/env node
/*
 * Push the Companies House prospects into HighLevel's Cold Lead stage.
 *
 *   node backend/scripts/gh-ch-push.cjs --apply [--limit N]
 *
 * Reads the three files the sweep produced -- the enriched prospects, the booking-widget
 * check and the harvested emails -- and creates a contact plus an opportunity for each
 * garage the matcher called new.
 *
 * Dry run unless --apply, because nothing here is convenient to undo.
 */
const fs = require('fs');
try { require('dotenv').config(); } catch { /* env may already be set */ }

const DATA = process.env.GH_DATA || '/home/ec2-user/gh-data';
const argv = process.argv.slice(2);
const opt = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const APPLY = argv.includes('--apply');
const LIMIT = Number(opt('--limit', '0'));

const KEY = process.env.GHL_API_KEY, LOC = process.env.GHL_LOCATION_ID;
const PIPELINE = opt('--pipeline', process.env.GHL_PIPELINE_ID);
const STAGE = opt('--stage', '37b4585c-465f-4861-b1dd-a0a830f46243');   // Onboarding Newest -> Cold Lead
const H = { Authorization: 'Bearer ' + KEY, Version: '2021-07-28', 'Content-Type': 'application/json' };

// A garage confirmed on Garage Hive is worth more: the Business Central integration
// already applies, so there is nothing to build before they can go live.
const VALUE_CONFIRMED = 399;
const VALUE_OTHER = 200;

// Already in Cold Lead from the welcome-post sweep -- pushing these again would duplicate
// yesterday's batch. Established by comparing against the stage itself, because the
// HighLevel contact dedupe did not catch them.
const ALREADY_PUSHED = new Set([
  'GARRISON GARAGE LIMITED', 'GOTHERINGTON CROSS GARAGE LIMITED', 'GX LANDROVERS LIMITED',
  'EASTMAINS GARAGE LIMITED', 'UCKFIELD MOTOR SERVICES LIMITED',
  'WILLIAM STREET MOTOR SERVICES LIMITED', 'FERDOTTI MOTOR SERVICES LIMITED',
  'CLEEVELY MOTORS LIMITED', 'RS AUTOTECHNIK LIMITED',
]);

function csvRows(file) {
  const txt = fs.readFileSync(file, 'utf8');
  const out = []; let cur = [], f = '', q = false;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (q) { if (c === '"') { if (txt[i + 1] === '"') { f += c; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { cur.push(f); f = ''; }
    else if (c === '\n') { cur.push(f); out.push(cur); cur = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f || cur.length) { cur.push(f); out.push(cur); }
  const hdr = out.shift();
  return out.filter(r => r.length > 3).map(r => Object.fromEntries(hdr.map((h, i) => [h, r[i]])));
}

const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };

/*
 * A garage's email often sits on a domain that is close to, but not the same as, its
 * website: sftebbyandson.com mails from sftebbyandson.co.uk, bandtmotorrepairs.co.uk from
 * bandtmotors.co.uk, and gashereford.com from grandstandautoservices.co.uk. Comparing
 * whole hostnames rejected all of those. Compare the distinctive label instead, and let
 * the company's own name vouch for a domain the website does not match.
 */
const WEBMAIL = /(gmail|outlook|hotmail|yahoo|btinternet|icloud|live\.|aol\.|sky\.com|talktalk)/i;
const label = (h) => (h || '').replace(/^www\./, '').split('.')[0].toLowerCase();
function sharedPrefix(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}
function trustedEmail(entry, website, company) {
  if (!entry) return '';
  let siteLabel = '';
  try { siteLabel = label(new URL(website.startsWith('http') ? website : 'https://' + website).hostname); } catch { /* none */ }
  const nameWords = String(company || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/).filter((w) => w.length >= 4 && !['limited', 'motor', 'motors', 'garage', 'services', 'service', 'auto', 'autos', 'centre'].includes(w));

  for (const e of entry.emails || []) {
    if (/[&;<>#]/.test(e)) continue;                       // mangled by entity encoding
    const d = (e.split('@')[1] || '').toLowerCase();
    if (!d || d === 'domain.com' || d === 'example.com') continue;
    if (WEBMAIL.test(d)) return e;
    const el = label(d);
    if (siteLabel && el === siteLabel) return e;
    if (siteLabel && sharedPrefix(el, siteLabel) >= 6) return e;
    if (nameWords.some((w) => el.includes(w))) return e;
  }
  return '';
}

(async () => {
  const rows = csvRows(`${DATA}/ch-prospects.csv`).filter(r => r.status === 'new');
  const widget = read(`${DATA}/ch-widget.json`);
  const emails = read(`${DATA}/ch-emails.json`);

  let todo = rows.filter(r => !ALREADY_PUSHED.has(r.company));
  if (LIMIT) todo = todo.slice(0, LIMIT);

  const plan = todo.map(r => {
    const w = widget[r.company] || {};
    const confirmed = Boolean(w.uses);
    return {
      r,
      confirmed,
      instance: w.instance || '',
      email: trustedEmail(emails[r.company], r.website || '', r.company),
      value: confirmed ? VALUE_CONFIRMED : VALUE_OTHER,
    };
  });

  const conf = plan.filter(p => p.confirmed).length;
  console.log(`${rows.length} new prospects, ${rows.length - todo.length} already in Cold Lead, pushing ${plan.length}`);
  console.log(`  Garage Hive confirmed : ${conf} at £${VALUE_CONFIRMED}`);
  console.log(`  rest                  : ${plan.length - conf} at £${VALUE_OTHER}`);
  console.log(`  with a phone          : ${plan.filter(p => p.r.phone).length}`);
  console.log(`  with an email         : ${plan.filter(p => p.email).length}`);
  console.log(`  pipeline value        : £${plan.reduce((t, p) => t + p.value, 0).toLocaleString()}`);
  if (!APPLY) {
    console.log('\n(dry run -- pass --apply)');
    plan.slice(0, 8).forEach(p => console.log(`   £${p.value}  ${p.r.company.slice(0, 32).padEnd(34)}${(p.r.phone || '-').padEnd(15)}${p.email || ''}`));
    return;
  }

  let ok = 0, skipped = 0, failed = 0;
  for (const p of plan) {
    const { r } = p;
    const tags = ['gh-companies-house', 'cold-prospect', ...(p.confirmed ? ['gh-confirmed'] : [])];
    try {
      // upsert identifies a contact by phone or email; with neither, create instead
      const hasId = Boolean(r.phone || p.email);
      const cRes = await fetch(hasId
        ? 'https://services.leadconnectorhq.com/contacts/upsert'
        : 'https://services.leadconnectorhq.com/contacts/', {
        method: 'POST', headers: H,
        body: JSON.stringify({
          locationId: LOC,
          name: r.company,
          firstName: r.company.split(/\s+/)[0],
          lastName: r.company.split(/\s+/).slice(1).join(' ') || '(garage)',
          companyName: r.company,
          ...(r.phone ? { phone: r.phone } : {}),
          ...(p.email ? { email: p.email } : {}),
          ...(r.website ? { website: r.website } : {}),
          ...(r.place_address ? { address1: r.place_address } : {}),
          ...(r.town ? { city: r.town } : {}),
          ...(r.postcode ? { postalCode: r.postcode } : {}),
          source: 'GH Community member via Companies House',
          tags,
        }),
      });
      if (!cRes.ok) throw new Error('contact ' + cRes.status + ' ' + (await cRes.text()).slice(0, 90));
      const cj = await cRes.json();
      const cid = cj.contact?.id || cj.id;
      if (!cid) throw new Error('no contact id');

      // never create a second opportunity for a contact that already has an open one
      const ex = await fetch(`https://services.leadconnectorhq.com/opportunities/search?location_id=${LOC}&contact_id=${cid}&status=open&limit=1`, { headers: H });
      if (ex.ok && ((await ex.json()).opportunities || []).length) { skipped++; continue; }

      const oRes = await fetch('https://services.leadconnectorhq.com/opportunities/', {
        method: 'POST', headers: H,
        body: JSON.stringify({
          pipelineId: PIPELINE, pipelineStageId: STAGE, locationId: LOC,
          contactId: cid, name: r.company, status: 'open', monetaryValue: p.value,
        }),
      });
      if (!oRes.ok) throw new Error('opportunity ' + oRes.status);

      const notes = [
        `Companies House ${r.company_number}${r.directors ? ' — director(s): ' + r.directors : ''}`,
        p.instance ? `Garage Hive confirmed from their booking widget. Instance: ${p.instance}` : '',
      ].filter(Boolean).join('\n');
      if (notes) {
        await fetch('https://services.leadconnectorhq.com/contacts/' + cid + '/notes', {
          method: 'POST', headers: H, body: JSON.stringify({ body: notes }),
        });
      }
      ok++;
      if (ok % 25 === 0) console.log(`  ...${ok} pushed`);
    } catch (e) { failed++; console.log(`  FAILED ${r.company} -- ${e.message}`); }
  }
  console.log(`\npushed ${ok}, skipped ${skipped} (already had an open opportunity), failed ${failed}`);
})().catch(e => { console.error(e); process.exit(1); });
