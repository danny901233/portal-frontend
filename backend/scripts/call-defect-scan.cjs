/**
 * Call defect scanner — finds the faults a call summary does not show, and
 * writes them to CallDefect for /observability to read.
 *
 * Scheduled by pm2 cron-restart. It does NOT alert: the watchdog owns outages
 * and pages a human; these are quality faults that belong on a page someone
 * reads. Exits after each run.
 *
 *   node scripts/call-defect-scan.cjs            scan and write
 *   node scripts/call-defect-scan.cjs --dry      scan and print, write nothing
 *   node scripts/call-defect-scan.cjs --hours=36 widen the window (backfill)
 *
 * Two traps this file is written around, both learned the hard way on this box:
 *
 *   1. Load the env file beside THIS script, not the one in the cwd. pm2 may
 *      launch us from the repo root, whose .env holds only DATABASE_URL —
 *      and because Prisma loads that itself, everything would appear to work.
 *   2. Never gate the run on `require.main === module`. pm2 fork mode requires
 *      the script from its own wrapper, so that condition is never true and the
 *      process exits 0 having done nothing, looking perfectly healthy. The
 *      default here is to RUN; a test opts out with DEFECT_SCAN_NO_AUTORUN=1.
 */
require('dotenv').config();
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { PrismaClient } = require('@prisma/client');
const { scanDefects } = require('./lib/call-defects.cjs');

const prisma = new PrismaClient();

// Three hours of calls per run, every 15 minutes. Call has no index on
// createdAt, so every one of these is a sequential scan of a ~300MB table —
// keep the window small and let overlapping runs rely on idempotency.
const WINDOW_HOURS = Number(process.env.DEFECT_SCAN_HOURS || 3);

/**
 * Which calls this run should look at.
 *
 * The window alone is not enough: a garage rates a call hours or days after it
 * happened, so feedback given this afternoon on Monday's call would never be
 * picked up by a rolling three-hour window. Any call with fresh feedback is
 * pulled in regardless of its age.
 */
function callIdsToScan({ windowCallIds, feedbackCallIds }) {
  return [...new Set([...(windowCallIds || []), ...(feedbackCallIds || [])])].filter(Boolean);
}

/**
 * The garage's custom rules as plain strings.
 *
 * Stored either as a list of `{ text, active }` objects or as one free-text blob, so both
 * shapes are flattened here and inactive rules are left out — an inactive rule is not
 * something the agent was told to say.
 */
function garageRuleTexts(garage) {
  const raw = garage && garage.agentConfiguration && garage.agentConfiguration.customRules;
  if (!raw) return [];
  if (typeof raw === 'string') return raw.trim() ? [raw.trim()] : [];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r) => (typeof r === 'string' ? r : (r && r.active !== false ? r.text : '')))
    .map((t) => String(t || '').trim())
    .filter(Boolean);
}

/**
 * Is this call worth paying a model to read?
 *
 * The analyst costs money per call, and most of what it would read has nothing
 * in it: a call under 30 seconds is not even emailed to the garage, and a call
 * the caller never spoke on gives nothing to judge the agent against. Gating on
 * these two roughly halves the spend and removes none of the findings — every
 * fault found over 124 calls on 21 Oct was on a call that passes this.
 */
function worthReading(call) {
  if (!call || Number(call.durationSeconds || 0) < 30) return false;
  const t = Array.isArray(call.transcript) ? call.transcript
    : (call.transcript && Array.isArray(call.transcript.turns) ? call.transcript.turns : []);
  return t.some((turn) => {
    const who = String((turn && (turn.speaker || turn.role || turn.type)) || '').toLowerCase();
    const isCaller = who.includes('caller') || who.includes('user') || who.includes('customer');
    return isCaller && String((turn && turn.text) || '').trim();
  });
}

/**
 * The analyst pass, loaded from the compiled backend.
 *
 * It lives in TypeScript under src/, so this reaches it through dist/ with a
 * dynamic import — backend/package.json is "type": "module", so a plain require
 * of the compiled file would fail. A missing or unbuilt dist is not an error
 * here: the deterministic findings still get written, and the log says the
 * analyst was skipped rather than failing the run.
 */
async function loadAnalyst() {
  if (process.env.DEFECT_SCAN_AI === '0') return null;
  try {
    const mod = await import(`file://${require('path').join(__dirname, '..', 'dist', 'services', 'callFaults.js')}`);
    return mod.findCallFaults || null;
  } catch (err) {
    console.warn('[defects] analyst unavailable (is dist built?):', err && err.message);
    return null;
  }
}

async function run({ dry = false, hours = WINDOW_HOURS } = {}) {
  const since = new Date(Date.now() - hours * 3600 * 1000);

  const windowCalls = await prisma.call.findMany({
    where: { createdAt: { gte: since }, garage: { isTestAccount: false, archivedAt: null } },
    select: { id: true },
  });
  // Feedback is keyed on the call's short id, and the row may be older than the
  // window, so this is a separate lookup rather than a join on the window.
  const freshFeedback = await prisma.callFeedback.findMany({
    where: { createdAt: { gte: since } },
    select: { callId: true, rating: true, reasons: true, notes: true },
  });

  const ids = callIdsToScan({
    windowCallIds: windowCalls.map((c) => c.id),
    feedbackCallIds: freshFeedback.map((f) => f.callId),
  });
  if (!ids.length) {
    console.log(`[defects] ${new Date().toISOString()} nothing in window (${hours}h)`);
    return { scanned: 0, found: 0 };
  }

  const calls = await prisma.call.findMany({
    where: { id: { in: ids } },
    select: {
      id: true, garageId: true, createdAt: true, durationSeconds: true,
      registrationNumber: true, confirmedBooking: true, metrics: true, transcript: true,
      summary: true, callType: true,
      garage: {
        select: {
          name: true, isTestAccount: true, archivedAt: true,
          // The garage's own rules. Without them the analyst judges a price or a process
          // with no idea what the garage told the agent to say, which is how Elite
          // Autocare's own alignment pricing came back as "told the caller something
          // untrue" on call 29225395.
          agentConfiguration: { select: { customRules: true } },
        },
      },
    },
  });
  const live = calls
    .filter((c) => c.garage && !c.garage.isTestAccount && !c.garage.archivedAt)
    .map((c) => ({ ...c, garageName: c.garage.name, garageRules: garageRuleTexts(c.garage) }));

  const findings = scanDefects(live, { feedback: freshFeedback });

  // The analyst reads what the field data cannot show: a value misheard and not
  // corrected, a promise the tools never kept, the agent collecting details
  // before helping. It is given the deterministic findings as established fact
  // so it extends them rather than restating them.
  const analyst = await loadAnalyst();
  let read = 0;
  if (analyst) {
    for (const call of live) {
      if (!worthReading(call)) continue;
      const known = findings.filter((f) => f.callId === call.id).map((f) => f.detail);
      let out = null;
      try {
        out = await analyst({
          transcript: call.transcript, metrics: call.metrics, summary: call.summary || undefined,
          callType: call.callType || undefined, confirmedBooking: call.confirmedBooking || false,
          knownSignals: known,
          rules: call.garageRules,
        });
      } catch (err) {
        console.error(`[defects] analyst failed on ${call.id}:`, err && err.message);
      }
      read += 1;
      for (const f of (out && out.findings) || []) {
        if (f.severity === 'low') continue; // polish; not worth a row on the page
        findings.push({
          callId: call.id,
          garageId: call.garageId,
          garageName: call.garageName,
          createdAt: call.createdAt,
          // Prefixed so the page can tell a read finding from a measured one.
          signature: `ai:${f.category}`,
          severity: f.severity,
          detail: f.evidence ? `${f.detail} — heard: "${f.evidence}"` : f.detail,
        });
      }
    }
  }

  if (dry) {
    const bySig = {};
    for (const f of findings) bySig[f.signature] = (bySig[f.signature] || 0) + 1;
    console.log(`[defects] DRY scanned=${live.length} read=${read} found=${findings.length} ${JSON.stringify(bySig)}`);
    for (const f of findings.slice(0, 15)) {
      console.log(`  ${f.severity.padEnd(6)} ${f.signature.padEnd(22)} ${f.callId} ${f.garageName || ''}`);
    }
    return { scanned: live.length, found: findings.length };
  }

  // Rewrite each scanned call's findings rather than upserting them one by one:
  // a finding can legitimately DISAPPEAR on a rescan (a garage changes a rating
  // from down to up), and an upsert-only pass would leave the stale row behind.
  const byCall = new Map();
  for (const f of findings) {
    if (!byCall.has(f.callId)) byCall.set(f.callId, []);
    byCall.get(f.callId).push(f);
  }
  let written = 0;
  for (const call of live) {
    const mine = byCall.get(call.id) || [];
    await prisma.$transaction([
      prisma.callDefect.deleteMany({ where: { callId: call.id } }),
      ...(mine.length
        ? [prisma.callDefect.createMany({
            data: mine.map((f) => ({
              callId: f.callId,
              garageId: f.garageId || call.garageId,
              signature: f.signature,
              severity: f.severity,
              detail: String(f.detail).slice(0, 2000),
              callAt: call.createdAt,
            })),
            skipDuplicates: true,
          })]
        : []),
    ]);
    written += mine.length;
  }

  const bySig = {};
  for (const f of findings) bySig[f.signature] = (bySig[f.signature] || 0) + 1;
  console.log(`[defects] ${new Date().toISOString()} scanned=${live.length} read=${read} written=${written} ${JSON.stringify(bySig)}`);
  return { scanned: live.length, found: written };
}

async function main() {
  const dry = process.argv.includes('--dry');
  const hoursArg = process.argv.find((a) => a.startsWith('--hours='));
  const hours = hoursArg ? Number(hoursArg.split('=')[1]) : WINDOW_HOURS;
  try {
    await run({ dry, hours });
  } catch (err) {
    // A monitor must fail loud. Print and exit non-zero so pm2's log shows it.
    console.error('[defects] run failed:', err && err.message);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

if (!process.env.DEFECT_SCAN_NO_AUTORUN) {
  main();
}

module.exports = { run, callIdsToScan, worthReading, garageRuleTexts, WINDOW_HOURS };
