/**
 * ReceptionMate daily call report.
 *
 * Every evening, answer the questions somebody would otherwise have to open fifty calls to
 * answer: did the agents respond quickly, did they hear the registrations, did the bookings
 * they claim to have made actually land in the right diary, and — for every caller who wanted
 * an appointment and didn't get one — what exactly went wrong, step by step.
 *
 * WHY IT GOES DEEPER THAN COUNTS. A bug that cost In'n'out Norwich seven MOT bookings sat
 * unnoticed for eight days in September. A bucket count would have shown "WRONG_SERVICE: 5"
 * and left somebody to work out the rest. What actually identified it was the tool sequence —
 *
 *     choose_service ["13693"]        -> WRONG_SERVICE      (13693 IS "MOT Class 4")
 *     choose_service ["9940"]         -> WRONG_SERVICE
 *     choose_service ["110994013693"] -> NO_SLOTS
 *
 * — read against the garage's own service catalogue, which showed the guard was redirecting a
 * correct MOT pick at a GBP227 combi bundle. So this report carries the sequence, the resolved
 * service NAMES, the guard's own words, and what changed since yesterday. Those are the things
 * that turn "a booking failed" into "here is the line to fix".
 *
 * Every number here is computed in this file, not by a model. The agents already emit a
 * structured error taxonomy and nobody was aggregating it. Counting is deterministic and
 * cheap; the model is handed finished figures and real traces and asked only what they mean.
 * It cannot invent a statistic it was not given.
 *
 * Scheduled by pm2 cron-restart at 19:00 Europe/London. Exits after each run.
 * Run from the backend dir so @prisma/client + dotenv resolve.
 *
 *   node daily-call-report.cjs             # send it
 *   node daily-call-report.cjs --dry       # print to stdout, send nothing
 *   node daily-call-report.cjs --days=3    # look back further (ad hoc)
 *   node daily-call-report.cjs --garage=In # only garages whose name contains "In"
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const TO = ['dan@receptionmate.co.uk', 'hello@receptionmate.co.uk'];
const DRY = process.argv.includes('--dry');
const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const DAYS = Number(arg('days', 1)) || 1;
const ONLY = arg('garage', '');
const CLAUDE_MODEL = process.env.REPORT_CLAUDE_MODEL || 'claude-sonnet-5';

// Statuses that mean the booking was REFUSED or BROKE, as opposed to the agent steering the
// conversation. READBACK / CONFIRM_NUMBER / ASK_FIRST / AREA_READBACK are mid-turn instructions
// to the model — the number read-back deliberately refuses once and asks again — and counting
// those as failures makes a perfectly healthy call look broken.
const FAILURE_STATUSES = [
  'ERROR', 'WRONG_SERVICE', 'SERVICE_MISMATCH', 'NO_SLOTS', 'NO_AVAILABILITY', 'BOOKINGS_DISABLED',
];

// Reaching one of these means a service was actually SELECTED and a time was being worked
// towards — the caller wanted an appointment. Deliberately NOT quote_services/start_quote:
// those fire for "what would a clutch cost?" too, and counting a price enquiry as a failed
// booking made the first draft of this report claim 82% of attempts failed when most were
// nothing of the kind. A report that overstates loss gets ignored, which is worse than no
// report.
const BOOKING_TOOLS = [
  'choose_service', 'pick_service', 'confirm_booking', 'check_date', 'search_available_slots',
];
const QUOTE_TOOLS = ['quote_services', 'start_quote'];

const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : '—');
const sorted = (xs) => xs.slice().sort((a, b) => a - b);
const med = (xs) => (xs.length ? sorted(xs)[Math.floor(xs.length / 2)] : null);
const p90 = (xs) => (xs.length ? sorted(xs)[Math.floor(xs.length * 0.9)] : null);
const f2 = (x) => (typeof x === 'number' ? x.toFixed(2) : '—');
const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').slice(0, n);
// Clipping mid-sentence made the first version unreadable — "The agent was unable to fi"
// tells you nothing. Wrap instead, and only ever cut at a word boundary.
const wrap = (text, width, indent) => {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ');
  const lines = []; let cur = '';
  for (const w of words) {
    if (cur && (cur + ' ' + w).length > width) { lines.push(cur); cur = w; } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  return lines.map((l, i) => (i === 0 ? l : indent + l));
};

function londonDayStart(daysBack) {
  const now = new Date();
  const local = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/London' }));
  const offsetMs = now.getTime() - local.getTime();
  local.setHours(0, 0, 0, 0);
  local.setDate(local.getDate() - (daysBack - 1));
  return new Date(local.getTime() + offsetMs);
}

const firstLine = (s) => String(s || '').split('\n')[0].trim();

function failureKind(hist) {
  for (const h of hist || []) {
    const m = firstLine(h.status).match(/STATUS:\s*([A-Z_]+)/);
    if (m && FAILURE_STATUSES.includes(m[1])) return m[1];
  }
  return null;
}

/**
 * The same tool with the same arguments three or more times. One retry is normal; three
 * identical calls means the model is stuck against a guard that will never let it through,
 * which is how a caller ends up being asked the same question until they give up.
 */
function repeatedTools(hist) {
  const seen = new Map();
  for (const h of hist || []) {
    const k = `${h.tool}|${JSON.stringify(h.args || {})}`;
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  return [...seen.entries()].filter(([, n]) => n >= 3)
    .map(([k, n]) => ({ tool: k.split('|')[0], times: n }));
}

/** Pull id -> service name out of any list-services response this garage has returned. */
function harvestServiceNames(trace, into) {
  for (const t of trace || []) {
    if (!/list-services/.test(t.path || '')) continue;
    const r = typeof t.response === 'string' ? t.response : JSON.stringify(t.response || '');
    // Responses are stored truncated, so JSON.parse is unreliable — match pairs directly.
    for (const m of r.matchAll(/"service_price_id":"?([^",]+)"?[^}]*?"name":"([^"]*)"/g)) {
      if (!into.has(m[1])) into.set(m[1], m[2]);
    }
  }
}

/** The service ids this call actually sent to the diary, in order. */
function servicesSet(trace) {
  const ids = [];
  for (const t of trace || []) {
    if (!/set-services/.test(t.path || '')) continue;
    const s = JSON.stringify(t.payload || '');
    for (const m of s.matchAll(/(\d{3,}|bundle-[\w_-]+)/g)) if (!ids.includes(m[1])) ids.push(m[1]);
  }
  return ids;
}

const CATCH_ALL = /^(other|misc|miscellaneous|general)$/i;

async function gather() {
  const from = londonDayStart(DAYS);
  const garages = await prisma.garage.findMany({
    select: { id: true, name: true, agentConfiguration: { select: { agentScript: true } } },
  });
  const nameOf = {}, scriptOf = {};
  garages.forEach((g) => { nameOf[g.id] = g.name; scriptOf[g.id] = g.agentConfiguration?.agentScript || '?'; });

  const R = {
    from, total: 0, booked: 0, intent: 0, intentFailed: 0, turns: 0,
    perGarage: {}, svcNames: new Map(),
    gapSec: [], maxSilence: [], ttft: [], ttfb: [],
    slow2: 0, slow3: 0, ttsStalls: 0,
    regAttempted: 0, regCaptured: 0, regRetried: 0,
    failures: {}, lostBookings: [], badBookings: [], goodBookings: [],
    quotes: 0, noFault: 0,
    repeats: [], diagnosisIssues: [], gaps: [], silentCalls: [],
  };

  // Page through the day so the whole set is never resident at once — this box has fallen over
  // on a query that loaded every call's metrics into memory.
  const PAGE = 40;
  for (let skip = 0; ; skip += PAGE) {
    const page = await prisma.call.findMany({
      where: { createdAt: { gte: from } },
      orderBy: { createdAt: 'asc' }, skip, take: PAGE,
      select: {
        id: true, createdAt: true, garageId: true, confirmedBooking: true, callType: true,
        durationSeconds: true, customerName: true, registrationNumber: true,
        summary: true, bookingDetails: true, metrics: true,
      },
    });
    if (!page.length) break;

    for (const c of page) {
      const g = nameOf[c.garageId] || c.garageId;
      if (ONLY && !g.toLowerCase().includes(ONLY.toLowerCase())) continue;
      const m = c.metrics || {};
      const hist = Array.isArray(m.tool_call_history) ? m.tool_call_history : [];
      const trace = Array.isArray(m.gh_trace) ? m.gh_trace : [];
      harvestServiceNames(trace, R.svcNames);

      R.total += 1;
      const G = (R.perGarage[g] = R.perGarage[g] || {
        calls: 0, booked: 0, failed: 0, intent: 0, script: scriptOf[c.garageId], gaps: [],
      });
      G.calls += 1;
      if (c.confirmedBooking) { R.booked += 1; G.booked += 1; }

      // --- endpointing -------------------------------------------------------------
      const L = m.latency || {};
      if (typeof L.response_gap_p50_s === 'number') { R.gapSec.push(L.response_gap_p50_s); G.gaps.push(L.response_gap_p50_s); }
      if (typeof L.max_silence_s === 'number') R.maxSilence.push(L.max_silence_s);
      if (typeof L.llm_ttft_max_s === 'number') R.ttft.push(L.llm_ttft_max_s);
      if (typeof L.tts_ttfb_max_s === 'number') R.ttfb.push(L.tts_ttfb_max_s);
      R.slow2 += L.slow_responses_over_2s || 0;
      R.slow3 += L.slow_responses_over_3s || 0;
      R.ttsStalls += L.tts_stalls || 0;
      R.turns += L.turns_measured || 0;

      // --- registration capture ----------------------------------------------------
      const cap = m.capture || {};
      if (cap.registration_attempts > 0) {
        R.regAttempted += 1;
        if (cap.registration_captured) R.regCaptured += 1;
        if (cap.registration_attempts > 2) R.regRetried += 1;
      }

      // A caller who says nothing at all, or an agent that never speaks: the one-way audio
      // signature. Short call, few or no tools, nothing captured.
      if (c.durationSeconds > 0 && c.durationSeconds < 45 && hist.length <= 1 && !c.registrationNumber) {
        R.silentCalls.push({ id: c.id, garage: g, secs: c.durationSeconds, summary: clip(c.summary, 110) });
      }

      const kind = failureKind(hist);
      if (kind) { R.failures[kind] = (R.failures[kind] || 0) + 1; G.failed += 1; }

      const reps = repeatedTools(hist);
      if (reps.length) R.repeats.push({ id: c.id, garage: g, who: c.customerName || '-', reps });

      const wantedToBook = hist.some((h) => BOOKING_TOOLS.includes(h.tool));
      if (wantedToBook) { R.intent += 1; G.intent += 1; }
      else if (hist.some((h) => QUOTE_TOOLS.includes(h.tool))) R.quotes += 1;

      // --- a caller who wanted to book and didn't: keep the WHOLE trace ------------
      // Only a call with an error status, or one the per-call verdict already judged as NOT
      // handled correctly, counts as lost to a FAULT. A caller who heard the times and chose
      // not to take one, or a garage whose agent takes details for the team to book, is a
      // different thing entirely and must not be reported as breakage.
      if (wantedToBook && !c.confirmedBooking) {
        const verdictBad = !!(m.diagnosis && m.diagnosis.status && m.diagnosis.status !== 'ok');
        if (!kind && !verdictBad) { R.noFault += 1; continue; }
        R.intentFailed += 1;
        const steps = hist.filter((h) => BOOKING_TOOLS.includes(h.tool)).map((h) => ({
          tool: h.tool,
          args: clip(JSON.stringify(h.args || {}), 90),
          status: firstLine(h.status),
        }));
        // The guard's own words carry the reasoning — which service it wanted instead, what
        // the diary said. That is the difference between a bucket and a diagnosis.
        const detail = hist.map((h) => String(h.status || ''))
          .filter((s) => FAILURE_STATUSES.some((f) => s.includes(`STATUS: ${f}`)))
          .map((s) => clip(s, 600))[0] || '';
        const apiErrors = trace.filter((t) => t.status && t.status >= 300)
          .map((t) => `${t.path} -> ${t.status} ${clip(typeof t.response === 'string' ? t.response : '', 120)}`);
        R.lostBookings.push({
          id: c.id, at: c.createdAt, garage: g, script: scriptOf[c.garageId],
          who: c.customerName || '-', reg: c.registrationNumber || '',
          kind: kind || 'no-error-status',
          want: clip(c.summary, 400), steps, detail, apiErrors,
        });
      }

      // --- did the confirmed bookings actually land, and in the right diary? -------
      if (c.confirmedBooking) {
        const ids = servicesSet(trace);
        const problems = [];
        const confirms = hist.filter((h) => h.tool === 'confirm_booking');
        const last = confirms.length ? firstLine(confirms[confirms.length - 1].status) : '';
        if (confirms.length && !/booking placed/i.test(last)) {
          problems.push(`last confirm_booking did not say "booking placed" — "${clip(last, 90)}"`);
        }
        const bad = trace.filter((t) => t.status && t.status >= 300);
        if (bad.length) problems.push(`diary returned ${bad.map((t) => `${t.path}:${t.status}`).join(', ')}`);
        // An MOT in the catch-all diary is an appointment the workshop may physically not be
        // able to honour — Other has its own bay and its own capacity.
        const txt = `${c.summary || ''} ${c.bookingDetails || ''}`;
        if (/\bmot\b/i.test(txt) && ids.length) {
          const names = ids.map((i) => R.svcNames.get(i) || i);
          if (!names.some((n) => /mot/i.test(n)) && names.some((n) => CATCH_ALL.test(String(n).trim()))) {
            problems.push(`caller mentioned MOT but it was booked as ${names.join(' + ')} — that is the catch-all diary`);
          }
        }
        const row = {
          id: c.id, garage: g, who: c.customerName || '-', reg: c.registrationNumber || '',
          services: ids.map((i) => `${i}=${R.svcNames.get(i) || '?'}`).join(' + ') || '(none recorded)',
          when: (last.match(/for (.+?)\.?$/) || [])[1] || '',
        };
        if (problems.length) R.badBookings.push({ ...row, problems });
        else R.goodBookings.push(row);
      }

      const d = m.diagnosis;
      if (d && d.status && d.status !== 'ok') {
        R.diagnosisIssues.push({
          id: c.id, garage: g, category: d.category,
          headline: clip(d.headline, 110), detail: clip(d.detail, 400),
        });
      }
    }
    if (page.length < PAGE) break;
  }

  // --- how does today compare? ------------------------------------------------------
  // A failure kind that is NEW, or several times its usual rate, is the thing worth looking at.
  // Counted DB-side so nothing large is pulled back.
  R.trend = {};
  for (const kind of FAILURE_STATUSES) {
    const rows = await prisma.$queryRawUnsafe(`
      SELECT COUNT(*)::int AS n FROM "Call"
      WHERE "createdAt" >= NOW() - INTERVAL '15 days' AND "createdAt" < $1
        AND metrics::text LIKE '%STATUS: ${kind}%'`, from);
    const per14 = (rows[0]?.n || 0) / 14;
    R.trend[kind] = { today: R.failures[kind] || 0, usual: per14 };
  }

  // --- call gaps: a garage that normally rings and today did not --------------------
  // A garage that stops forwarding gets zero AI calls and usually says nothing, so the silence
  // has to be noticed here rather than waiting for a complaint.
  const baseline = await prisma.$queryRawUnsafe(`
    SELECT "garageId", COUNT(*)::float / 14 AS per_day
    FROM "Call"
    WHERE "createdAt" >= NOW() - INTERVAL '15 days' AND "createdAt" < NOW() - INTERVAL '1 day'
    GROUP BY 1 HAVING COUNT(*) >= 14`);
  for (const b of baseline) {
    const g = nameOf[b.garageId];
    if (!g || (ONLY && !g.toLowerCase().includes(ONLY.toLowerCase()))) continue;
    if (!(R.perGarage[g]?.calls)) R.gaps.push({ garage: g, usual: b.per_day.toFixed(1) });
  }
  return R;
}

function render(R) {
  const day = R.from.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  const L = [];
  const h = (t) => { L.push('', t, '-'.repeat(t.length)); };

  L.push(`RECEPTIONMATE — CALL REPORT, ${day}${DAYS > 1 ? ` (${DAYS} days)` : ''}`);
  L.push('='.repeat(72));
  L.push(`Calls ${R.total}    booked ${R.booked} (${pct(R.booked, R.total)})    turns measured ${R.turns}`);
  L.push(`Chose a service (wanted an appointment): ${R.intent}`);
  L.push(`  lost to a FAULT: ${R.intentFailed} (${pct(R.intentFailed, R.intent)})   no fault found (caller declined, or garage books manually): ${R.noFault}`);
  L.push(`Price enquiries that never reached a booking: ${R.quotes}`);

  h('ENDPOINTING — how long callers waited for a reply');
  L.push(`  response gap        median ${f2(med(R.gapSec))}s   p90 ${f2(p90(R.gapSec))}s`);
  L.push(`  longest silence     median ${f2(med(R.maxSilence))}s   p90 ${f2(p90(R.maxSilence))}s`);
  L.push(`  LLM first token     median ${f2(med(R.ttft))}s`);
  L.push(`  TTS first byte      median ${f2(med(R.ttfb))}s`);
  L.push(`  replies over 2s ${R.slow2}    over 3s ${R.slow3}    TTS stalls ${R.ttsStalls}`);
  const worst = Object.entries(R.perGarage).filter(([, s]) => s.gaps.length >= 3)
    .map(([g, s]) => [g, med(s.gaps)]).sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (worst.length) L.push(`  slowest garages: ${worst.map(([g, v]) => `${g} ${f2(v)}s`).join(', ')}`);

  h('REGISTRATION CAPTURE');
  L.push(`  asked on ${R.regAttempted} calls, captured on ${R.regCaptured} (${pct(R.regCaptured, R.regAttempted)})`);
  L.push(`  needed 3+ attempts on ${R.regRetried} (${pct(R.regRetried, R.regAttempted)})`);

  h('TOOL FAILURES — today vs the last fortnight');
  const tr = Object.entries(R.trend).filter(([, v]) => v.today || v.usual >= 0.5)
    .sort((a, b) => b[1].today - a[1].today);
  if (!tr.length) L.push('  none');
  tr.forEach(([k, v]) => {
    const flag = v.today && v.usual < 0.2 ? '  <<< NEW'
      : v.today > Math.max(3, v.usual * 3) ? '  <<< SPIKE' : '';
    L.push(`  ${String(v.today).padStart(3)}  ${k.padEnd(20)} usual ${v.usual.toFixed(1)}/day${flag}`);
  });

  if (R.lostBookings.length) {
    h(`LOST TO A FAULT — ALL ${R.lostBookings.length}, WITH THE TRACE`);
    const byKind = {};
    R.lostBookings.forEach((f) => { (byKind[f.kind] = byKind[f.kind] || []).push(f); });
    for (const [kind, list] of Object.entries(byKind).sort((a, b) => b[1].length - a[1].length)) {
      L.push('', `### ${kind} — ${list.length} call(s)`);
      for (const f of list.slice(0, 12)) {
        L.push('', '  ' + '·'.repeat(70));
        L.push(`  ${f.at.toISOString().slice(11, 16)}  ${f.garage} — ${f.who}${f.reg ? ` (${f.reg})` : ''}`);
        L.push(`  ${' '.repeat(7)}${f.script}   call ${f.id}`);
        wrap(f.want, 82, ' '.repeat(17)).forEach((l, i) => L.push(i === 0 ? `         wanted: ${l}` : l));
        L.push('');
        f.steps.forEach((s) => {
          L.push(`         ${s.tool} ${s.args}`);
          L.push(`           -> ${s.status}`);
        });
        // Only worth printing when the guard explained itself. For a bare NO_SLOTS the detail
        // is just the status again, and repeating it is the sort of noise that stops people
        // reading the report at all.
        const extra = f.detail.replace(/^STATUS:\s*[A-Z_]+\s*/, '').trim();
        if (extra.length > 15) {
          f.detail = extra;
          L.push('');
          wrap(f.detail, 82, ' '.repeat(17)).forEach((l, i) => L.push(i === 0 ? `         reason: ${l}` : l));
        }
        f.apiErrors.forEach((e) => wrap(e, 82, ' '.repeat(17))
          .forEach((l, i) => L.push(i === 0 ? `         diary:  ${l}` : l)));
      }
      if (list.length > 12) L.push(`  ... and ${list.length - 12} more`);
    }
  }

  h(`BOOKINGS MADE — ${R.goodBookings.length} clean, ${R.badBookings.length} worth checking`);
  R.badBookings.forEach((b) => {
    L.push(`  !! ${b.garage} — ${b.who} ${b.reg} — ${b.services}`);
    b.problems.forEach((p) => L.push(`       ${p}`));
    L.push(`       call: ${b.id}`);
  });
  R.goodBookings.slice(0, 15).forEach((b) => {
    L.push(`  ok ${b.garage.slice(0, 26).padEnd(26)} ${String(b.who).slice(0, 16).padEnd(16)} ${b.services}`);
  });
  if (R.goodBookings.length > 15) L.push(`  ... and ${R.goodBookings.length - 15} more clean bookings`);

  if (R.repeats.length) {
    h('STUCK LOOPS — same tool, same arguments, 3+ times');
    R.repeats.slice(0, 12).forEach((r) => L.push(
      `  ${r.garage} — ${r.who} — ${r.reps.map((x) => `${x.tool} x${x.times}`).join(', ')}  (${r.id})`));
  }

  if (R.silentCalls.length) {
    h('POSSIBLE ONE-WAY AUDIO — short call, no tools, nothing captured');
    R.silentCalls.slice(0, 10).forEach((s) => L.push(`  ${s.garage} — ${s.secs}s — ${s.summary}`));
  }

  if (R.gaps.length) {
    h('CALL GAPS — normally busy, silent today (check forwarding)');
    R.gaps.forEach((g) => L.push(`  ${g.garage} — usually ~${g.usual}/day`));
  }

  if (R.diagnosisIssues.length) {
    h(`PER-CALL AI VERDICTS FLAGGING A PROBLEM — ${R.diagnosisIssues.length}`);
    R.diagnosisIssues.slice(0, 12).forEach((d) => {
      L.push(`  ${d.garage} — ${d.headline}  [${d.category}]`);
      wrap(d.detail, 84, ' '.repeat(6)).forEach((l) => L.push(`      ${l}`.replace(/^ {6} {6}/, '      ')));
    });
  }

  h('PER GARAGE');
  Object.entries(R.perGarage).sort((a, b) => b[1].calls - a[1].calls).forEach(([g, s]) => {
    L.push(`  ${g.slice(0, 30).padEnd(30)} ${String(s.script).slice(0, 22).padEnd(22)} calls ${String(s.calls).padStart(3)}  booked ${String(s.booked).padStart(2)} (${pct(s.booked, s.calls).padStart(6)})  wanted ${String(s.intent).padStart(3)}  failures ${s.failed}`);
  });

  return L.join('\n');
}

/** Hand Claude the finished numbers AND the real traces; ask for judgement, never arithmetic. */
async function narrate(report) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const prompt = [
    'You are the engineer on call for ReceptionMate, an AI phone receptionist used by UK garages.',
    'Below is tonight\'s automatically generated call report. Every figure in it is already correct.',
    'Do not recompute anything, do not invent numbers, and do not repeat the tables back.',
    '',
    'The report includes the full tool-call trace for every caller who wanted an appointment and',
    'did not get one, the guard messages verbatim, and the resolved service names. Use them.',
    '',
    'Write a briefing for the founder in plain British English:',
    '',
    '1. ROOT CAUSE. For the biggest group of lost bookings, work out from the traces what actually',
    '   went wrong — which tool returned what, and why that was the wrong answer. Name the service',
    '   ids and garages. If a guard refused a pick that looks correct, say so explicitly.',
    '2. NEW OR KNOWN. Anything marked NEW or SPIKE: is it a genuine new fault, or the known ones?',
    '   Say plainly if nothing is new.',
    '3. CHECK THESE. Bookings flagged "worth checking" — which need a human to look in the diary',
    '   tonight, and which are cosmetic.',
    '4. TOMORROW. What to do, in priority order, most valuable first. Be specific.',
    '',
    'Be concrete and brief. Quote a trace line when it makes the point faster than prose. If the',
    'day was unremarkable say so in two sentences rather than padding. If the data does not',
    'explain something, say that instead of speculating — a wrong confident answer costs more',
    'than an honest gap.',
    '',
    '--- REPORT ---',
    report,
  ].join('\n');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 2000, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) { console.error('claude failed', res.status, (await res.text()).slice(0, 300)); return null; }
  const j = await res.json();
  return (j.content || []).map((c) => c.text).join('').trim();
}

async function sendEmail(subject, text) {
  const key = process.env.MAILGUN_API_KEY, domain = process.env.MAILGUN_DOMAIN;
  const from = process.env.MAILGUN_FROM || `alerts@${domain}`;
  const base = (process.env.MAILGUN_API_BASE || 'https://api.mailgun.net').replace(/\/$/, '');
  if (!key || !domain) { console.error('mailgun not configured'); return; }
  const body = new URLSearchParams();
  body.append('from', `ReceptionMate Reports <${from}>`);
  TO.forEach((t) => body.append('to', t));
  body.append('subject', subject);
  body.append('text', text);
  const res = await fetch(`${base}/v3/${domain}/messages`, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`api:${key}`).toString('base64')}` },
    body,
  });
  console.log('email', res.status, res.ok ? 'sent' : (await res.text()).slice(0, 200));
}

(async () => {
  try {
    const R = await gather();
    const table = render(R);
    const brief = await narrate(table);
    const body = brief
      ? `${brief}\n\n${'='.repeat(72)}\nTHE UNDERLYING REPORT\n${'='.repeat(72)}\n\n${table}`
      : `${table}\n\n(No written analysis: ANTHROPIC_API_KEY is not set on this host.)`;
    const subject = `ReceptionMate daily — ${R.total} calls, ${R.booked} booked, ${R.intentFailed} lost to faults`;
    if (DRY) console.log(`SUBJECT: ${subject}\nTO: ${TO.join(', ')}\n\n${body}`);
    else await sendEmail(subject, body);
  } catch (e) {
    console.error('daily call report failed:', e);
    if (!DRY) await sendEmail('ReceptionMate daily report FAILED', String((e && e.stack) || e));
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
