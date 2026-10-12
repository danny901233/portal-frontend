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
const distinctive = (s) => new Set([...tokens(s)].filter((t) => !GENERIC.has(t) && t.length > 1));

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
function distinctiveEditRatio(a, b) {
  const A = [...distinctive(a)].sort().join('');
  const B = [...distinctive(b)].sort().join('');
  if (!A || !B) return 0;
  return 1 - levenshtein(A, B) / Math.max(A.length, B.length);
}

/*
 * A ratio punishes short names: "vgs" against "vwgs" is one dropped letter but only
 * 0.75, which would bin the real VGS/VWGS Performance match. One character out is a typo
 * at any length, so allow it alongside the ratio.
 */
function nearlySameName(a, b) {
  const A = [...distinctive(a)].sort().join('');
  const B = [...distinctive(b)].sort().join('');
  if (!A || !B) return false;
  // One character out is a typo on a reasonable-length name, but on a three-letter
  // initialism it is a different business: "AFS" and "ADS" are not each other.
  if (Math.max(A.length, B.length) >= 4 && levenshtein(A, B) <= 1) return true;
  return distinctiveEditRatio(a, b) >= 0.85;
}

const MATCH_SURE = 0.9;
const MATCH_MAYBE = 0.62;

function bestMatch(name, known) {
  let best = null;
  for (const g of known) {
    const nA = norm(name), nB = norm(g.name);
    if (!nA || !nB) continue;
    let score, how;
    if (nA === nB) { score = 1; how = 'exact'; }
    else if (nA.length > 6 && nB.length > 6 && (nA.includes(nB) || nB.includes(nA))) { score = 0.95; how = 'contains'; }
    else {
      const j = jaccard(name, g.name), e = distinctiveEditRatio(name, g.name);
      score = Math.max(j, e);
      how = j >= e ? 'tokens' : 'edit';
    }
    // Require something distinctive in common before trusting a partial match.
    if (how !== 'exact' && how !== 'contains') {
      const dA = distinctive(name), dB = distinctive(g.name);
      let shared = false;
      for (const t of dA) if (dB.has(t)) shared = true;
      if (!shared && !nearlySameName(name, g.name)) score = 0;
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
 * Places returns a confident result for any string, so a name we got slightly wrong comes
 * back enriched with someone else's phone number. A result is only accepted when the
 * distinctive words searched for actually appear in it -- that keeps a fuller trading
 * name ("AFS Repair" -> "AFS Auto Repair Centre") and rejects "Nick and" -> "St Nic's
 * Church". Returns { rejected } rather than null so the caller can record the near miss.
 */
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
      placeName: got,
      address: p.formattedAddress || '',
      phone: p.nationalPhoneNumber || '',
      website: p.websiteUri || '',
    };
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
