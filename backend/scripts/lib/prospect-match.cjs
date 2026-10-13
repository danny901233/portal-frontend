/*
 * Shared matching and enrichment for the Garage Hive prospecting scripts.
 *
 * Both the welcome-post sweep (gh-prospects.cjs) and the Companies House member sweep
 * (gh-ch-prospects.cjs) have to answer the same two questions: is this garage already
 * known to us, and what are its contact details? The answers were worked out against the
 * welcome-post data and are kept here so the two cannot drift apart.
 */

// Words almost every garage name contains, so they are not evidence that two names are
// the same business -- "Marieston Service Centre" and "Ecotest MOT & Service Centre"
// share two of three words and are unrelated. Connectives sit here for the same reason.
const GENERIC = new Set([
  'garage', 'garages', 'service', 'services', 'centre', 'center', 'motors', 'motor',
  'auto', 'autos', 'automotive', 'mot', 'car', 'cars', 'vehicle', 'vehicles', 'repair',
  'repairs', 'tyre', 'tyres', 'workshops', 'cars', 'commercials', 'engineering',
  'solutions', 'group', 'specialist', 'specialists', 'station', 'performance',
  'and', 'to', 'at', 'with', 'for', 'from', 'this', 'that', 'all', 'as', 'they',
  // trade words that describe what a garage does rather than which garage it is
  'tuning', 'servicing', 'diagnostics', 'bodyshop', 'bodyworks', 'coachworks', 'mots',
  'mechanic', 'mechanics', 'autocentre', 'autocentres', 'workshop', 'point', 'care',
]);

const SUFFIXES = /\b(ltd|limited|llp|plc|uk|co|company|the)\b/g;

// Apostrophes close up rather than splitting: "Martin's" must stay one token, or
// "Martins Auto" can never match "Martin's Auto Services".
const norm = (s) => (s || '').toLowerCase()
  .replace(/['’]/g, '')
  .replace(/[^a-z0-9\s]/g, ' ')
  .replace(SUFFIXES, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const tokens = (s) => new Set(norm(s).split(' ').filter(Boolean));

/*
 * `ignore` carries the garage's town. A place name is not a distinguishing word: "Oxford
 * Commercials" and "J S Motors Oxford" both reduce to "oxford" once the trade words go,
 * and scored a perfect match despite being unrelated businesses. Same for Bicester,
 * Bristol, Bridgnorth and Winton across the Companies House sweep.
 */
const distinctive = (s, ignore) => new Set([...tokens(s)]
  .filter((t) => !GENERIC.has(t) && t.length > 1 && !(ignore && ignore.has(t))));

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

// Token overlap alone misses a typo or a dropped letter in a trading name -- "VGS
// Performance" and the portal's "VWGS Performance" share one token out of two.
function editRatio(a, b) {
  const A = norm(a).replace(/\s/g, ''), B = norm(b).replace(/\s/g, '');
  if (!A || !B) return 0;
  return 1 - levenshtein(A, B) / Math.max(A.length, B.length);
}

/*
 * Edit distance over the WHOLE name is dominated by the generic words every garage
 * shares, so "MJS Garage Services" and "A J Garage Services" came out at 0.88 and
 * "IC Garage" and "T I C Garage" at 0.89 -- different businesses, both wrongly withheld
 * from the pipeline as possible duplicates. Comparing only the distinctive words puts
 * those at 0.0 while a real match ("Wiseman Motors Services" / "Wiseman Motor Services
 * Limited") stays at 1.0. With no distinctive word on either side there is nothing to
 * judge, so it scores nothing rather than guessing.
 */
function distinctiveEditRatio(a, b, ignore) {
  const A = [...distinctive(a, ignore)].sort().join('');
  const B = [...distinctive(b, ignore)].sort().join('');
  if (!A || !B) return 0;
  return 1 - levenshtein(A, B) / Math.max(A.length, B.length);
}

/*
 * A ratio punishes short names: "vgs" against "vwgs" is one dropped letter but only
 * 0.75, which would bin the real VGS/VWGS Performance match. One character out is a typo
 * at any length, so allow it alongside the ratio.
 */
function nearlySameName(a, b, ignore) {
  const A = [...distinctive(a, ignore)].sort().join('');
  const B = [...distinctive(b, ignore)].sort().join('');
  if (!A || !B) return false;
  // One character out is a typo on a reasonable-length name, but on a three-letter
  // initialism it is a different business: "AFS" and "ADS" are not each other.
  if (Math.max(A.length, B.length) >= 4 && levenshtein(A, B) <= 1) return true;
  return distinctiveEditRatio(a, b, ignore) >= 0.85;
}

const MATCH_SURE = 0.9;
const MATCH_MAYBE = 0.62;

/*
 * `town` is the prospect's town, excluded from the distinguishing words.
 *
 * Errors here are not symmetric. Wrongly calling a garage a duplicate drops it from the
 * pipeline and nobody ever looks again; wrongly calling it new costs almost nothing,
 * because HighLevel's upsert merges contacts on phone number and the push skips any
 * contact that already has an open opportunity. So when the evidence is one shared word,
 * lean towards new.
 */
/*
 * One name containing the other is only evidence when the contained part says WHICH
 * business it is. "Drive Safe MOT Centre" contains "The MOT Centre" and "FD Mechanics"
 * contains "The Mechanic", and both were being dropped as existing customers -- silently,
 * because unlike a flagged match nobody ever reviews those.
 */
function containsSomethingDistinctive(a, b, ignore) {
  const dA = distinctive(a, ignore), dB = distinctive(b, ignore);
  const shorter = norm(a).length <= norm(b).length ? dA : dB;
  const longer = shorter === dA ? dB : dA;
  if (!shorter.size) return false;
  return [...shorter].every((t) => longer.has(t));
}

function bestMatch(name, known, town) {
  const ignore = town ? tokens(town) : null;
  let best = null;
  for (const g of known) {
    const nA = norm(name), nB = norm(g.name);
    if (!nA || !nB) continue;
    let score, how;
    if (nA === nB) { score = 1; how = 'exact'; }
    else if (nA.length > 6 && nB.length > 6 && (nA.includes(nB) || nB.includes(nA)) &&
             containsSomethingDistinctive(name, g.name, ignore)) { score = 0.95; how = 'contains'; }
    else {
      const j = jaccard(name, g.name);
      const e = distinctiveEditRatio(name, g.name, ignore);
      // A near-identical full string catches compound-word splits the distinctive-word
      // comparison cannot see -- "TWA Auto Electrics" and "TWA Autoelectrics" are the
      // same characters. The bar is high on purpose: "MJS Garage Services" against
      // "A J Garage Services" reaches 0.88 on shared trade words alone.
      const whole = editRatio(name, g.name);
      score = Math.max(j, e, whole >= 0.92 ? whole : 0);
      how = j >= e ? 'tokens' : 'edit';
    }
    // Require something distinctive in common before trusting a partial match.
    if (how !== 'exact' && how !== 'contains') {
      const dA = distinctive(name, ignore), dB = distinctive(g.name, ignore);
      const shared = [...dA].filter((t) => dB.has(t));
      if (editRatio(name, g.name) >= 0.92) {
        // the names are the same characters; nothing below should overrule that
      } else if (!shared.length) {
        if (!nearlySameName(name, g.name, ignore)) score = 0;
      } else if (
        shared.length === 1 &&
        jaccard(name, g.name) < 0.5 &&
        distinctiveEditRatio(name, g.name, ignore) < 0.85
      ) {
        // One word in common while the rest of the name goes its own way is a
        // coincidence, not a duplicate. Names whose distinguishing content agrees as a
        // whole ("Elite Land Rover" / "Elite Landrover") are unaffected.
        score = 0;
      }
    }
    if (!best || score > best.score) best = { garage: g.name, source: g.source, score, how };
  }
  return best && best.score > 0 ? best : null;
}

// Only an exact or containment match may retire a prospect outright; a near-identical
// spelling goes to 'check', because silently dropping a real garage costs more.
function statusFor(m) {
  if (!m) return 'new';
  const sure = m.score >= MATCH_SURE && (m.how === 'exact' || m.how === 'contains');
  return sure ? 'existing' : m.score >= MATCH_MAYBE ? 'check' : 'new';
}

const PLACES_KEY =
  process.env.GOOGLE_PLACES_API_KEY ||
  process.env.GOOGLE_MAPS_API_KEY ||
  process.env.PUBLIC_GOOGLE_MAPS_API_KEY ||
  '';

const hasPlacesKey = () => Boolean(PLACES_KEY);

/*
 * Places lookups are the only part of this that costs money, and a sweep re-runs the
 * whole list every time -- seven iterations of the welcome-post sweep during development
 * paid for the same ~150 garages seven times. Cache on disk by query so a re-run only
 * pays for names it has never seen.
 */
const CACHE_PATH = process.env.PLACES_CACHE || '';
let cache = null;
function loadCache() {
  if (cache) return cache;
  cache = {};
  if (CACHE_PATH) {
    try { cache = JSON.parse(require('fs').readFileSync(CACHE_PATH, 'utf8')); } catch { cache = {}; }
  }
  return cache;
}
function saveCache() {
  if (!CACHE_PATH) return;
  try { require('fs').writeFileSync(CACHE_PATH, JSON.stringify(cache)); } catch { /* best effort */ }
}

/*
 * Places returns a confident result for any string, so a name we got slightly wrong comes
 * back enriched with someone else's phone number. A result is only accepted when the
 * distinctive words searched for actually appear in it -- that keeps a fuller trading
 * name ("AFS Repair" -> "AFS Auto Repair Centre") and rejects "Nick and" -> "St Nic's
 * Church". Returns { rejected } rather than null so the caller can record the near miss.
 */
async function enrich(name, hint) {
  if (!PLACES_KEY) return null;
  const query = [name, hint, 'UK'].filter(Boolean).join(' ');
  const c = loadCache();
  if (Object.prototype.hasOwnProperty.call(c, query)) return c[query];
  try {
    const resp = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': PLACES_KEY,
        'X-Goog-FieldMask':
          'places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri',
      },
      body: JSON.stringify({ textQuery: query, maxResultCount: 1 }),
    });
    if (!resp.ok) return null;
    const j = await resp.json();
    const p = (j.places || [])[0];
    if (!p) { c[query] = null; saveCache(); return null; }

    const got = p.displayName?.text || '';
    const want = distinctive(name), gotTokens = tokens(got);
    const allPresent = want.size > 0 && [...want].every((t) => gotTokens.has(t));
    const resembles =
      allPresent ||
      editRatio(name, got) >= 0.6 ||
      norm(got).includes(norm(name)) ||
      norm(name).includes(norm(got)) ||
      (want.size === 0 && jaccard(name, got) >= 0.4);
    if (!resembles) { c[query] = { rejected: got }; saveCache(); return c[query]; }

    c[query] = {
      placeId: p.id || '',
      placeName: got,
      address: p.formattedAddress || '',
      phone: p.nationalPhoneNumber || '',
      website: p.websiteUri || '',
    };
    saveCache();
    return c[query];
  } catch {
    return null;
  }
}

/*
 * A garage already in the Onboarding pipeline is not a new prospect, so the portal's
 * Garage table is only half the dedupe. Returns null (not an empty list) when it cannot
 * look, so the caller can say so loudly instead of treating known leads as fresh.
 */
async function loadHighLevel(fileArg) {
  const fs = require('fs');
  if (fileArg) {
    const txt = fs.readFileSync(fileArg, 'utf8').trim();
    let names;
    if (txt.startsWith('[')) {
      names = JSON.parse(txt).map((c) => (typeof c === 'string' ? c : c.companyName || c.name));
    } else {
      const lines = txt.split('\n').filter(Boolean);
      if (/name/i.test(lines[0])) lines.shift();
      names = lines.map((l) => (l.match(/^\s*"([^"]*)"/) || [, l.split(',')[0]])[1]);
    }
    const clean = [...new Set(names.map((n) => String(n || '').trim()).filter(Boolean))];
    return clean.map((name) => ({ name, source: 'highlevel' }));
  }

  const key = process.env.GHL_API_KEY, loc = process.env.GHL_LOCATION_ID;
  if (!key || !loc) return null;
  const headers = { Authorization: `Bearer ${key}`, Version: '2021-07-28', 'Content-Type': 'application/json' };
  const names = new Set();
  try {
    for (let page = 1; page <= 40; page++) {
      const res = await fetch('https://services.leadconnectorhq.com/contacts/search', {
        method: 'POST', headers,
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
    return [...names].map((name) => ({ name, source: 'highlevel' }));
  } catch (e) {
    console.error(`HighLevel lookup failed (${e.message}) -- continuing without CRM dedupe`);
    return null;
  }
}

// Dedupe is the whole point, so an empty, unreachable, or obviously-dev garage list must
// stop the run rather than mark every existing customer as a new prospect.
const MIN_PLAUSIBLE_GARAGES = 20;

module.exports = {
  GENERIC, norm, tokens, distinctive, jaccard, levenshtein, editRatio,
  bestMatch, statusFor, MATCH_SURE, MATCH_MAYBE, MIN_PLAUSIBLE_GARAGES, distinctiveEditRatio, nearlySameName,
  enrich, hasPlacesKey, loadHighLevel,
};
