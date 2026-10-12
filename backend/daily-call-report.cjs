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
 *   node daily-call-report.cjs --dry --html  # --dry, and also print the HTML part
 *   node daily-call-report.cjs --days=3    # look back further (ad hoc)
 *   node daily-call-report.cjs --garage=In # only garages whose name contains "In"
 *
 * The send is always both text and HTML (Mailgun's multipart — a client that renders HTML
 * shows it, everything else falls back to the text part). See renderHtml() below: table-based
 * layout, inline styles only, web-safe fonts — written for Outlook desktop's Word rendering
 * engine, which is most of what this report's two recipients actually read it in.
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
        regAsked: 0, regGot: 0,
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
      // Count from the tool history and the stored plate, NOT metrics.capture. That object's
      // registration_attempts is only written on a fraction of calls while registration_captured
      // is written on far more, so the ratio of the two comes out above 100% and is worthless —
      // Elite Autocare read as "asked 5, captured 39". Ask = the agent called the tool at all.
      const regCalls = hist.filter((x) => x.tool === 'capture_registration');
      if (regCalls.length) {
        R.regAttempted += 1; G.regAsked += 1;
        if (c.registrationNumber) { R.regCaptured += 1; G.regGot += 1; }
        if (regCalls.length > 2) R.regRetried += 1;
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
  L.push(`  agent asked on ${R.regAttempted} of ${R.total} calls; got a plate on ${R.regCaptured} (${pct(R.regCaptured, R.regAttempted)})`);
  L.push(`  needed 3+ spelling attempts on ${R.regRetried} (${pct(R.regRetried, R.regAttempted)})`);
  // Reg capture tracks booking rate more tightly than anything else measured here: across
  // September the garages at 65-87% booked 12-30% of calls and those at 33-43% booked 0.8-8%.
  const poor = Object.entries(R.perGarage).filter(([, s2]) => s2.regAsked >= 8)
    .map(([g, s2]) => [g, s2.regGot / s2.regAsked]).filter(([, r]) => r < 0.55)
    .sort((a, b) => a[1] - b[1]);
  if (poor.length) {
    L.push(`  BELOW 55%, where bookings dry up: ${poor.map(([g, r]) => `${g} ${(r * 100).toFixed(0)}%`).join(', ')}`);
  }

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

// --- HTML rendering ---------------------------------------------------------------
//
// Table-based layout with inline styles throughout, deliberately — Dan reads this in Outlook
// desktop, which renders HTML email through Word's engine: no CSS Grid/Flexbox, no custom
// properties, no box-shadow, no webfonts. Every color and spacing value below is a literal,
// repeated inline on each element, because that's the only thing Outlook reliably honours.
// border-radius is kept as a harmless extra (Outlook just squares the corners off).
//
// Mirrors render() section-for-section and reuses its exact truncation limits (slice(0,12) etc)
// so the HTML and plain-text versions never disagree about what got left out.

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// FAILURE_STATUSES -> red, a bare "OK" -> green, anything else (ASK_FIRST, CONFIRM_NUMBER,
// READBACK...) is a mid-turn instruction to the model, not a failure -> amber.
function statusPill(status) {
  const code = (String(status).match(/STATUS:\s*([A-Z_]+)/) || [])[1] || '';
  const bg = FAILURE_STATUSES.includes(code) ? '#fbe9e7' : /^OK$/.test(code) ? '#e6f4ec' : '#faf0dd';
  const fg = FAILURE_STATUSES.includes(code) ? '#b3261e' : /^OK$/.test(code) ? '#1f7a4d' : '#a6650a';
  return `<span style="background-color:${bg};color:${fg};font-weight:bold;padding:1px 6px;border-radius:8px;font-size:10px;">${esc(code || '?')}</span>`;
}

function faultStripeColor(kind) {
  if (kind === 'no-error-status') return '#9a9c9a';
  return FAILURE_STATUSES.includes(kind) ? '#b3261e' : '#a6650a';
}

const FONT_SERIF = "Georgia,'Times New Roman',serif";
const FONT_SANS = "Arial,Helvetica,sans-serif";
const FONT_MONO = "'Courier New',Courier,monospace";

function htmlTable(attrs = '') {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ${attrs}>`;
}

function htmlPanel(inner, extra = '') {
  return `${htmlTable(`style="background-color:#ffffff;border:1px solid #e3e1da;border-radius:6px;${extra}"`)}${inner}</table>`;
}

function htmlSectionHeading(title, countLabel) {
  return `<tr><td style="padding-bottom:10px;font-family:${FONT_SERIF};">
    <span style="font-size:18px;font-weight:bold;color:#1b1d22;">${esc(title)}</span>
    ${countLabel ? `<span style="font-family:${FONT_MONO};font-size:11px;color:#6b6f78;"> &mdash; ${esc(countLabel)}</span>` : ''}
  </td></tr>`;
}

function htmlSpacer(px) {
  return `<tr><td style="font-size:${px}px;line-height:${px}px;">&nbsp;</td></tr>`;
}

function renderHtml(R, brief) {
  const day = R.from.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  const sections = [];

  // --- masthead: 3 headline stat tiles ------------------------------------------
  sections.push(`
  <tr><td style="padding:0 0 16px;">
    ${htmlPanel(`
      <tr><td style="padding:24px 24px 20px;">
        <div style="font-family:${FONT_MONO};font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#6b6f78;">
          DAILY SEND &middot; ${TO.map(esc).join(', ')}
        </div>
        <div style="font-family:${FONT_SERIF};font-weight:bold;font-size:25px;line-height:1.2;color:#1b1d22;padding-top:6px;">
          ReceptionMate &mdash; Call Report
        </div>
        <div style="font-family:${FONT_SERIF};font-style:italic;font-size:15px;color:#6b6f78;padding-top:2px;padding-bottom:18px;">
          ${esc(day)}${DAYS > 1 ? ` (${DAYS} days)` : ''}
        </div>
        ${htmlTable()}<tr>
          <td width="33%" valign="top" style="padding-right:6px;">
            ${htmlPanel(`<tr><td style="padding:13px 14px;">
              <div style="font-family:${FONT_MONO};font-weight:bold;font-size:24px;color:#1b1d22;">${R.total}</div>
              <div style="font-family:${FONT_SANS};font-size:11px;color:#6b6f78;padding-top:3px;">calls handled</div>
              <div style="font-family:${FONT_SANS};font-size:10.5px;color:#9a9c9a;padding-top:1px;">${R.turns} turns measured</div>
            </td></tr>`, 'background-color:#faf9f5;')}
          </td>
          <td width="34%" valign="top" style="padding-left:3px;padding-right:3px;">
            ${htmlPanel(`<tr><td style="padding:13px 14px;">
              <div style="font-family:${FONT_MONO};font-weight:bold;font-size:24px;color:#1f7a4d;">${R.booked} <span style="font-size:13px;font-weight:normal;">(${pct(R.booked, R.total)})</span></div>
              <div style="font-family:${FONT_SANS};font-size:11px;color:#6b6f78;padding-top:3px;">bookings confirmed</div>
              <div style="font-family:${FONT_SANS};font-size:10.5px;color:#9a9c9a;padding-top:1px;">${R.goodBookings.length} clean &middot; ${R.badBookings.length} worth checking</div>
            </td></tr>`, 'background-color:#faf9f5;')}
          </td>
          <td width="33%" valign="top" style="padding-left:6px;">
            ${htmlPanel(`<tr><td style="padding:13px 14px;">
              <div style="font-family:${FONT_MONO};font-weight:bold;font-size:24px;color:#b3261e;">${R.intentFailed} <span style="font-size:13px;font-weight:normal;">(${pct(R.intentFailed, R.intent)})</span></div>
              <div style="font-family:${FONT_SANS};font-size:11px;color:#6b6f78;padding-top:3px;">lost to a fault</div>
              <div style="font-family:${FONT_SANS};font-size:10.5px;color:#9a9c9a;padding-top:1px;">of ${R.intent} who chose a service &middot; ${R.quotes} price enquiries never booked</div>
            </td></tr>`, 'background-color:#faf9f5;')}
          </td>
        </tr></table>
      </td></tr>`)}
  </td></tr>`);
  sections.push(htmlSpacer(8));

  // --- sub-stats: endpointing / reg capture / tool failures ---------------------
  const worst = Object.entries(R.perGarage).filter(([, s]) => s.gaps.length >= 3)
    .map(([g, s]) => [g, med(s.gaps)]).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const trendRows = Object.entries(R.trend).filter(([, v]) => v.today || v.usual >= 0.5)
    .sort((a, b) => b[1].today - a[1].today).slice(0, 3);

  const subCard = (title, rows, foot, footColor) => htmlPanel(`<tr><td style="padding:14px 15px;font-family:${FONT_SANS};">
    <div style="font-size:10.5px;text-transform:uppercase;letter-spacing:0.5px;color:#6b6f78;font-weight:bold;padding-bottom:8px;">${esc(title)}</div>
    ${rows.map((r) => `<div style="font-size:12px;color:#3c3f46;padding-bottom:5px;">${r}</div>`).join('')}
    ${foot ? `<div style="font-size:11px;color:${footColor || '#9a9c9a'};padding-top:8px;border-top:1px dashed #e3e1da;">${foot}</div>` : ''}
  </td></tr>`);

  sections.push(`<tr><td>${htmlTable()}<tr>
    <td width="33%" valign="top" style="padding-right:5px;padding-bottom:10px;">
      ${subCard('Endpointing', [
        `Response gap <strong style="font-family:${FONT_MONO};float:right;">${f2(med(R.gapSec))}s / ${f2(p90(R.gapSec))}s</strong>`,
        `Longest silence <strong style="font-family:${FONT_MONO};float:right;">${f2(med(R.maxSilence))}s / ${f2(p90(R.maxSilence))}s</strong>`,
        `LLM first token <strong style="font-family:${FONT_MONO};float:right;">${f2(med(R.ttft))}s</strong>`,
      ], worst.length ? `Slowest: ${esc(worst.map(([g, v]) => `${g} ${f2(v)}s`).join(', '))}` : '')}
    </td>
    <td width="34%" valign="top" style="padding-left:3px;padding-right:3px;padding-bottom:10px;">
      ${subCard('Registration capture', [
        `Asked <strong style="font-family:${FONT_MONO};float:right;">${R.regAttempted} / ${R.total}</strong>`,
        `Captured <strong style="font-family:${FONT_MONO};color:#1f7a4d;float:right;">${pct(R.regCaptured, R.regAttempted)}</strong>`,
        `3+ attempts <strong style="font-family:${FONT_MONO};float:right;">${pct(R.regRetried, R.regAttempted)}</strong>`,
      ], 'Steady vs. fortnight baseline')}
    </td>
    <td width="33%" valign="top" style="padding-left:6px;padding-bottom:10px;">
      ${subCard('Tool failures vs. usual', trendRows.length ? trendRows.map(([k, v]) => {
        const hot = v.today && v.usual < 0.2 ? '#b3261e' : v.today > Math.max(3, v.usual * 3) ? '#b3261e' : '#3c3f46';
        return `${esc(k)} <strong style="font-family:${FONT_MONO};color:${hot};float:right;">${v.today}</strong>`;
      }) : ['No notable failures today'], '')}
    </td>
  </tr></table></td></tr>`);
  sections.push(htmlSpacer(4));

  // --- lost to a fault: one card per call, same 12-per-kind cap as the text version
  if (R.lostBookings.length) {
    const byKind = {};
    R.lostBookings.forEach((f) => { (byKind[f.kind] = byKind[f.kind] || []).push(f); });
    const cards = [];
    for (const [, list] of Object.entries(byKind).sort((a, b) => b[1].length - a[1].length)) {
      for (const f of list.slice(0, 12)) {
        const stepRows = f.steps.map((s) => `${esc(s.tool)} ${esc(s.args)} &nbsp;${statusPill(s.status)}`).join('<br>');
        const extra = f.detail.replace(/^STATUS:\s*[A-Z_]+\s*/, '').trim();
        cards.push(`<tr>
          <td width="4" style="background-color:${faultStripeColor(f.kind)};font-size:0;line-height:0;">&nbsp;</td>
          <td style="padding:14px 16px;border-bottom:1px solid #e3e1da;font-family:${FONT_SANS};">
            <div style="font-size:13px;color:#1b1d22;"><strong>${esc(f.garage)}</strong>
              &nbsp;<span style="font-family:${FONT_MONO};font-size:11px;color:#6b6f78;">${esc(f.at.toISOString().slice(11, 16))} &middot; call ${esc(f.id)}</span>
              ${f.reg ? `&nbsp;<span style="font-family:${FONT_MONO};font-size:10.5px;background-color:#faf9f5;border:1px solid #e3e1da;padding:1px 5px;color:#3c3f46;">${esc(f.reg)}</span>` : ''}
            </div>
            <div style="font-size:12px;color:#3c3f46;padding:5px 0 8px;">${esc(clip(f.want, 260))}</div>
            ${htmlPanel(`<tr><td style="padding:7px 9px;font-family:${FONT_MONO};font-size:11px;color:#3c3f46;">${stepRows}</td></tr>`, 'background-color:#faf9f5;')}
            ${extra.length > 15 ? `<div style="font-size:11.5px;color:#6b6f78;padding-top:6px;font-style:italic;">${esc(clip(extra, 220))}</div>` : ''}
          </td>
        </tr>`);
      }
    }
    const shown = Object.values(byKind).reduce((n, l) => n + Math.min(l.length, 12), 0);
    sections.push(`<tr><td>${htmlTable()}${htmlSectionHeading('Lost to a fault', `all ${R.lostBookings.length}, with the trace`)}</table>
      ${htmlPanel(cards.join('') + (R.lostBookings.length > shown
        ? `<tr><td colspan="2" style="padding:10px 16px;background-color:#faf9f5;border-top:1px solid #e3e1da;font-family:${FONT_SANS};font-size:11px;color:#9a9c9a;font-style:italic;">+ ${R.lostBookings.length - shown} more below the fold in the full report</td></tr>`
        : ''))}
    </td></tr>`);
    sections.push(htmlSpacer(18));
  }

  // --- bookings made --------------------------------------------------------------
  const bookingRows = [
    ...R.badBookings.map((b) => `<tr style="background-color:#faf0dd;">
      <td style="padding:8px 14px;border-bottom:1px solid #e3e1da;color:#1b1d22;">${esc(b.garage)}</td>
      <td style="padding:8px 14px;border-bottom:1px solid #e3e1da;color:#1b1d22;">${esc(b.who)} ${b.reg ? `&middot; ${esc(b.reg)}` : ''}</td>
      <td style="padding:8px 14px;border-bottom:1px solid #e3e1da;color:#a6650a;">!! ${esc(b.problems.join('; '))}</td>
    </tr>`),
    ...R.goodBookings.slice(0, 15).map((b, i, arr) => `<tr>
      <td style="padding:8px 14px;${i < arr.length - 1 ? 'border-bottom:1px solid #e3e1da;' : ''}color:#1b1d22;">${esc(b.garage)}</td>
      <td style="padding:8px 14px;${i < arr.length - 1 ? 'border-bottom:1px solid #e3e1da;' : ''}">${esc(b.who)}</td>
      <td style="padding:8px 14px;${i < arr.length - 1 ? 'border-bottom:1px solid #e3e1da;' : ''}">${esc(b.services)}</td>
    </tr>`),
  ];
  sections.push(`<tr><td>${htmlTable()}${htmlSectionHeading('Bookings made', `${R.goodBookings.length} clean, ${R.badBookings.length} worth checking`)}</table>
    ${htmlPanel(`<tr style="background-color:#faf9f5;">
        <td style="padding:9px 14px;font-size:10.5px;text-transform:uppercase;letter-spacing:0.5px;color:#6b6f78;border-bottom:1px solid #e3e1da;font-family:${FONT_SANS};">Garage</td>
        <td style="padding:9px 14px;font-size:10.5px;text-transform:uppercase;letter-spacing:0.5px;color:#6b6f78;border-bottom:1px solid #e3e1da;font-family:${FONT_SANS};">Customer</td>
        <td style="padding:9px 14px;font-size:10.5px;text-transform:uppercase;letter-spacing:0.5px;color:#6b6f78;border-bottom:1px solid #e3e1da;font-family:${FONT_SANS};">Service / note</td>
      </tr>${bookingRows.join('')}`, `font-family:${FONT_SANS};font-size:12px;`)}
    ${R.goodBookings.length > 15 ? `<div style="padding:8px 2px;font-family:${FONT_SANS};font-size:11px;color:#9a9c9a;font-style:italic;">+ ${R.goodBookings.length - 15} more clean bookings</div>` : ''}
  </td></tr>`);
  sections.push(htmlSpacer(18));

  // --- three callout boxes: stuck loops / one-way audio / call gaps ---------------
  if (R.repeats.length || R.silentCalls.length || R.gaps.length) {
    const callout = (icon, title, count, items, moreNote) => `<td width="33%" valign="top" style="padding:0 5px 8px 0;">
      ${htmlPanel(`<tr><td style="padding:13px 14px;font-family:${FONT_SANS};">
        <div style="font-size:12px;font-weight:bold;color:#1b1d22;padding-bottom:7px;">${icon} ${esc(title)} <span style="font-family:${FONT_MONO};font-weight:normal;color:#6b6f78;">(${count})</span></div>
        ${items.map((i) => `<div style="font-size:11px;color:#3c3f46;padding-bottom:5px;">${i}</div>`).join('')}
        ${moreNote ? `<div style="font-size:11px;color:#9a9c9a;">${esc(moreNote)}</div>` : ''}
      </td></tr>`)}
    </td>`;
    sections.push(`<tr><td>${htmlTable()}${htmlSectionHeading('Flags worth a look')}</table>
      ${htmlTable()}<tr>
        ${R.repeats.length ? callout('&#128257;', 'Stuck loops', R.repeats.length,
          R.repeats.slice(0, 4).map((r) => `<strong>${esc(r.garage)}</strong> &mdash; ${esc(r.who)}, ${esc(r.reps.map((x) => `${x.tool} x${x.times}`).join(', '))}`),
          R.repeats.length > 4 ? `+ ${R.repeats.length - 4} more` : '') : '<td width="33%">&nbsp;</td>'}
        ${R.silentCalls.length ? callout('&#128263;', 'One-way audio', R.silentCalls.length,
          R.silentCalls.slice(0, 4).map((s) => `<strong>${esc(s.garage)}</strong> &mdash; ${s.secs}s`),
          R.silentCalls.length > 4 ? `+ ${R.silentCalls.length - 4} more` : '') : '<td width="33%">&nbsp;</td>'}
        ${R.gaps.length ? callout('&#128201;', 'Call gaps', R.gaps.length,
          R.gaps.slice(0, 4).map((g) => `<strong>${esc(g.garage)}</strong> &mdash; usually ~${g.usual}/day`),
          R.gaps.length > 4 ? `+ ${R.gaps.length - 4} more — check forwarding` : 'check forwarding') : '<td width="33%">&nbsp;</td>'}
      </tr></table>
    </td></tr>`);
    sections.push(htmlSpacer(18));
  }

  // --- AI verdicts flagging a problem ----------------------------------------------
  if (R.diagnosisIssues.length) {
    const shown = R.diagnosisIssues.slice(0, 12);
    const rows = shown.map((d, i) => `<tr><td style="padding:10px 14px;${i < shown.length - 1 ? 'border-bottom:1px solid #e3e1da;' : ''}font-family:${FONT_SANS};">
      <div style="font-size:12.5px;font-weight:bold;color:#1b1d22;">${esc(d.garage)} &mdash; ${esc(d.headline)}</div>
      <div style="font-size:11.5px;color:#6b6f78;padding-top:2px;">${esc(clip(d.detail, 200))}</div>
    </td><td align="right" style="padding:10px 14px;${i < shown.length - 1 ? 'border-bottom:1px solid #e3e1da;' : ''}vertical-align:top;">
      <span style="font-family:${FONT_MONO};font-size:10px;background-color:#faf9f5;border:1px solid #e3e1da;padding:2px 7px;border-radius:6px;color:#3c3f46;white-space:nowrap;">${esc(d.category)}</span>
    </td></tr>`);
    sections.push(`<tr><td>${htmlTable()}${htmlSectionHeading('AI verdicts flagging a problem', `${R.diagnosisIssues.length} total`)}</table>
      ${htmlPanel(rows.join('') + (R.diagnosisIssues.length > 12
        ? `<tr><td colspan="2" style="padding:10px 14px;background-color:#faf9f5;border-top:1px solid #e3e1da;font-family:${FONT_SANS};font-size:11px;color:#9a9c9a;font-style:italic;">+ ${R.diagnosisIssues.length - 12} more verdicts in the full report</td></tr>`
        : ''))}
    </td></tr>`);
    sections.push(htmlSpacer(18));
  }

  // --- per garage -------------------------------------------------------------------
  const garageRows = Object.entries(R.perGarage).sort((a, b) => b[1].calls - a[1].calls);
  const shownGarages = garageRows.slice(0, 15);
  const garageTr = shownGarages.map(([g, s], i) => {
    const convPct = s.calls ? (s.booked / s.calls) * 100 : 0;
    const convColor = convPct >= 15 ? '#1f7a4d' : convPct === 0 ? '#9a9c9a' : '#3c3f46';
    const last = i === shownGarages.length - 1;
    return `<tr>
      <td style="padding:8px 14px;${last ? '' : 'border-bottom:1px solid #e3e1da;'}color:#1b1d22;">${esc(g)}</td>
      <td align="right" style="padding:8px 14px;${last ? '' : 'border-bottom:1px solid #e3e1da;'}font-family:${FONT_MONO};">${s.calls}</td>
      <td align="right" style="padding:8px 14px;${last ? '' : 'border-bottom:1px solid #e3e1da;'}font-family:${FONT_MONO};">${s.booked}</td>
      <td align="right" style="padding:8px 14px;${last ? '' : 'border-bottom:1px solid #e3e1da;'}font-family:${FONT_MONO};color:${convColor};">${pct(s.booked, s.calls)}</td>
      <td align="right" style="padding:8px 14px;${last ? '' : 'border-bottom:1px solid #e3e1da;'}font-family:${FONT_MONO};color:${s.failed ? '#b3261e' : '#9a9c9a'};">${s.failed}</td>
    </tr>`;
  }).join('');
  sections.push(`<tr><td>${htmlTable()}${htmlSectionHeading('Per garage', `${garageRows.length} garages`)}</table>
    ${htmlPanel(`<tr style="background-color:#faf9f5;">
        <td style="padding:9px 14px;font-size:10.5px;text-transform:uppercase;color:#6b6f78;border-bottom:1px solid #e3e1da;font-family:${FONT_SANS};">Garage</td>
        <td align="right" style="padding:9px 14px;font-size:10.5px;text-transform:uppercase;color:#6b6f78;border-bottom:1px solid #e3e1da;font-family:${FONT_SANS};">Calls</td>
        <td align="right" style="padding:9px 14px;font-size:10.5px;text-transform:uppercase;color:#6b6f78;border-bottom:1px solid #e3e1da;font-family:${FONT_SANS};">Booked</td>
        <td align="right" style="padding:9px 14px;font-size:10.5px;text-transform:uppercase;color:#6b6f78;border-bottom:1px solid #e3e1da;font-family:${FONT_SANS};">Conv.</td>
        <td align="right" style="padding:9px 14px;font-size:10.5px;text-transform:uppercase;color:#6b6f78;border-bottom:1px solid #e3e1da;font-family:${FONT_SANS};">Fails</td>
      </tr>${garageTr}`, `font-family:${FONT_SANS};font-size:12px;`)}
    ${garageRows.length > 15 ? `<div style="padding:8px 2px;font-family:${FONT_SANS};font-size:11px;color:#9a9c9a;font-style:italic;">+ ${garageRows.length - 15} more garages</div>` : ''}
  </td></tr>`);

  // --- written analysis / dev note --------------------------------------------------
  const briefBlock = brief
    ? `<tr><td style="padding:16px 0;">${htmlPanel(`<tr><td style="padding:16px 18px;font-family:${FONT_SANS};font-size:13px;color:#1b1d22;line-height:1.6;white-space:pre-wrap;">${esc(brief)}</td></tr>`, 'background-color:#eaeef5;border-color:#c9d3e3;')}</td></tr>`
    : `<tr><td style="padding:16px 0;">${htmlPanel(`<tr><td style="padding:11px 14px;font-family:${FONT_SANS};font-size:12px;color:#a6650a;">&#9888;&nbsp; <strong style="color:#1b1d22;">No written analysis:</strong> ANTHROPIC_API_KEY is not set on this host.</td></tr>`, 'background-color:#faf0dd;')}</td></tr>`;

  return `<body style="margin:0;padding:0;background-color:#f0efe9;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f0efe9;">
<tr><td align="center" style="padding:28px 12px 48px;">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="width:640px;max-width:640px;">
${brief ? briefBlock : ''}
${sections.join('')}
${brief ? '' : briefBlock}
<tr><td align="center" style="padding:20px 0 0;font-family:${FONT_SERIF};font-style:italic;font-size:11px;color:#9a9c9a;">
  Generated nightly at 19:00 Europe/London &middot; daily-call-report.cjs
</td></tr>
</table>
</td></tr>
</table>
</body>`;
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

async function sendEmail(subject, text, html) {
  const key = process.env.MAILGUN_API_KEY, domain = process.env.MAILGUN_DOMAIN;
  const from = process.env.MAILGUN_FROM || `alerts@${domain}`;
  const base = (process.env.MAILGUN_API_BASE || 'https://api.mailgun.net').replace(/\/$/, '');
  if (!key || !domain) { console.error('mailgun not configured'); return; }
  const body = new URLSearchParams();
  body.append('from', `ReceptionMate Reports <${from}>`);
  TO.forEach((t) => body.append('to', t));
  body.append('subject', subject);
  body.append('text', text);
  // Mailgun sends both parts; a client that renders HTML shows it, everything else falls back
  // to text. html is optional so the failure-path send (just a stack trace) stays plain text.
  if (html) body.append('html', html);
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
    const html = renderHtml(R, brief);
    const subject = `ReceptionMate daily — ${R.total} calls, ${R.booked} booked, ${R.intentFailed} lost to faults`;
    if (DRY) {
      console.log(`SUBJECT: ${subject}\nTO: ${TO.join(', ')}\n\n${body}`);
      if (process.argv.includes('--html')) console.log(`\n${'='.repeat(72)}\nHTML PART\n${'='.repeat(72)}\n\n${html}`);
    } else await sendEmail(subject, body, html);
  } catch (e) {
    console.error('daily call report failed:', e);
    if (!DRY) await sendEmail('ReceptionMate daily report FAILED', String((e && e.stack) || e));
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
