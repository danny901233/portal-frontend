/**
 * ReceptionMate agent watchdog.
 *
 * Proactively detects agent outages so we hear about them before a garage does. Two checks:
 *   1. HEARTBEAT  — during business hours, alert if a whole fleet (assist / automate) has logged
 *                   ZERO calls for longer than its threshold (a fleet-wide outage / backend down).
 *   2. ROUTING    — alert if any active garage is mis-routed to a LiveKit account that has no agent
 *                   for it (exactly the Speedy Spanners failure: assist garage pointing at account 1).
 *   3. RESPONSE   — alert if a fleet is ANSWERING calls but not RESPONDING: the caller speaks and gets
 *                   only the greeting with no LLM turn (greet-then-silence). Catches bad agent deploys /
 *                   LLM faults that the heartbeat misses because calls still connect and log normally.
 *
 * Alerts go out ONCE per issue (email + SMS), with a "recovered" message when it clears, using a
 * small state file so we don't spam. Scheduled by pm2 cron-restart every 5 minutes.
 *
 * Run from the backend dir so @prisma/client + dotenv resolve. Exits after each run.
 */
require('dotenv').config();
const fs = require('fs');
const https = require('https');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// ---- config ----
const ALERT_EMAILS = ['hello@receptionmate.co.uk'];
const ALERT_SMS = ['+447976500282'];
const SMS_FROM = 'RMonitor'; // alphanumeric sender id (one-way, UK)
const STATE_FILE = `${__dirname}/.watchdog-state.json`;
const TEST_MODE = process.argv.includes('--test');

// Fleet-wide silence (minutes) during business hours that counts as "down".
const SILENCE_MIN = { automate: 45, assist: 90 };

// Response-health: a caller-engaged call that gets only the greeting and logs no LLM = a silent failure.
// Alert when a fleet crosses BOTH an absolute count and a share of engaged calls within the window.
const RESP_WINDOW_MIN = 20;
const RESP_MIN_FAILS = 3;
const RESP_FAIL_RATIO = 0.6;

// UNHEARD: the caller's words never reached the agent at all, so the transcript has no caller
// turn to find. The response check above CANNOT see this — it starts from callerEngaged(), and
// this failure erases exactly that evidence. On 2026-09-25 a duplicate module-level name made
// on_user_turn_completed throw on every caller turn; LiveKit aborts a turn when that hook raises,
// so 27 calls across 11 garages logged a greeting, "are you still there?", and nothing else. The
// fleet looked healthy on every other measure: calls connected, Call rows appeared, volume normal.
// A call is only logged past 30s, so a long call where the caller never registers is already odd;
// a cluster of them is an agent that has gone deaf. Back-tested over the 14 days to 25 Sep: fires
// in exactly two windows, both inside that outage, and nowhere else.
const UNHEARD_MIN_SECS = 30;
const UNHEARD_MIN_FAILS = 3;
const UNHEARD_FAIL_RATIO = 0.6;

// LiveKit account each garage SHOULD land on, by agent type. assist -> account 2 (the Assist agent);
// automate/tyresoft -> account 1. routesToAccount2 mirrors the portal voice webhook's logic.
const routesToAccount2 = (script) => script === 'Assist-agent' || script === 'GarageHive-agent';
const EXPECTED_ACCOUNT2 = { assist: true, automate: false };
// Internal/test garages we don't page on for routing.
const SKIP_NAME_RE = /receptionmate branch|\btest\b/i;

// ---- time helpers (Europe/London) ----
function londonParts() {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map((x) => [x.type, x.value]));
  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { day: dayMap[p.weekday], hour: Number(p.hour), minute: Number(p.minute) };
}
function inBusinessHours() {
  const { day, hour } = londonParts();
  if (day === 0) return false;                 // Sunday off
  if (day === 6) return hour >= 9 && hour < 13; // Sat morning
  return hour >= 9 && (hour < 17 || (hour === 17 && londonParts().minute <= 30)); // Mon-Fri 9:00-17:30
}

// ---- checks ----
async function checkHeartbeat() {
  const issues = [];
  const cfgs = await prisma.agentConfiguration.findMany({ select: { garageId: true, agentType: true } });
  const byType = { assist: [], automate: [] };
  for (const c of cfgs) (byType[c.agentType === 'assist' ? 'assist' : 'automate']).push(c.garageId);

  for (const fleet of ['assist', 'automate']) {
    const ids = byType[fleet];
    if (!ids.length) continue;
    const last = await prisma.call.findFirst({
      where: { garageId: { in: ids } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true },
    });
    const mins = last ? Math.round((Date.now() - last.createdAt.getTime()) / 60000) : Infinity;
    if (mins > SILENCE_MIN[fleet]) {
      const since = last ? last.createdAt.toISOString() : 'never';
      issues.push({
        key: `heartbeat:${fleet}`,
        msg: `No ${fleet.toUpperCase()} calls logged for ${mins === Infinity ? '∞' : mins} min (last: ${since}). The ${fleet} agents may be down or calls aren't routing.`,
      });
    }
  }
  return issues;
}

async function checkRouting() {
  const issues = [];
  const cfgs = await prisma.agentConfiguration.findMany({ select: { garageId: true, agentType: true, agentScript: true } });
  const garages = await prisma.garage.findMany({
    select: { id: true, name: true, twilioNumber: true, archivedAt: true },
  });
  const nameById = new Map(garages.map((g) => [g.id, g.name]));
  const byId = new Map(garages.map((g) => [g.id, g]));
  for (const c of cfgs) {
    const name = nameById.get(c.garageId) || c.garageId;
    if (SKIP_NAME_RE.test(name)) continue;
    // No number pointing at it, or archived, means no call can arrive — so a routing mistake
    // cannot strand a caller and is not worth waking anyone for. "ReceptionMate Demo" held this
    // alert open permanently with twilioNumber = null, and an alarm that is always on is an alarm
    // people learn to ignore, which costs us the real ones.
    const g = byId.get(c.garageId);
    if (!g || !g.twilioNumber || g.archivedAt) continue;
    // Unified garages are checked by checkUnifiedRouting() instead — they live in their own
    // LiveKit project and the account-1/account-2 question does not apply to them. Skipping them
    // here is right; skipping them ENTIRELY is what let Bracknell sit dead for 24 hours.
    if (c.agentScript === 'unified-agent') continue;
    const type = c.agentType === 'assist' ? 'assist' : 'automate';
    const actual2 = routesToAccount2(c.agentScript);
    if (actual2 !== EXPECTED_ACCOUNT2[type]) {
      const acct = actual2 ? 'account 2' : 'account 1';
      issues.push({
        key: `route:${c.garageId}`,
        msg: `MIS-ROUTED: "${name}" (${type}, script "${c.agentScript}") points at ${acct}, which has no ${type} agent — its calls will ring unanswered. Fix agentScript.`,
      });
    }
  }
  return issues;
}

// ---- UNIFIED ROUTING: does the garage actually have somewhere for its calls to land? --------
//
// /voice sends a unified-agent garage to the unified project's SIP domain. If that project has
// no inbound trunk carrying the garage id, the call has nowhere to go and simply dies — Twilio
// records a 0-second call and we log nothing at all.
//
// That is exactly what happened to In'n'out Bracknell: its agentScript was switched to
// unified-agent on 18 Sep and no trunk was ever created, so every call from 09:36 that morning
// was lost. Nothing here noticed, because checkRouting skipped unified garages outright and the
// hard-down check needs three calls inside 90 minutes on a branch that takes a handful a day.
// EAC Telford lost a week the same way earlier in the month.
//
// A trunk is found by the garage id, which every trunk carries as one of its "numbers" —
// ensureUnifiedSipRouting writes it that way on purpose so the pair can be found again.
async function checkUnifiedRouting() {
  const issues = [];
  const url = process.env.LIVEKIT_UNIFIED_URL;
  const key = process.env.LIVEKIT_UNIFIED_API_KEY;
  const secret = process.env.LIVEKIT_UNIFIED_API_SECRET;
  // Not configured is not an outage. Say so once rather than alerting on every garage.
  if (!url || !key || !secret) {
    console.warn('[watchdog] LIVEKIT_UNIFIED_* not set — unified routing unchecked');
    return issues;
  }

  let trunks, rules;
  try {
    const { SipClient } = require('livekit-server-sdk');
    const sip = new SipClient(url, key, secret);
    // Once per run, not once per garage.
    trunks = await sip.listSipInboundTrunk();
    rules = await sip.listSipDispatchRule();
  } catch (e) {
    // Never let a LiveKit hiccup take the other checks down, and never alert on one: an API we
    // could not reach tells us nothing about whether the routing exists.
    console.error('[watchdog] unified SIP lookup failed:', e.message);
    return issues;
  }

  const garages = await prisma.garage.findMany({
    where: { archivedAt: null, twilioNumber: { not: null } },
    select: { id: true, name: true, agentConfiguration: { select: { agentScript: true } } },
  });

  for (const g of garages) {
    if (g.agentConfiguration?.agentScript !== 'unified-agent') continue;
    if (SKIP_NAME_RE.test(g.name)) continue;

    const trunk = (trunks || []).find((t) => (t.numbers || []).includes(g.id));
    if (!trunk) {
      issues.push({
        key: 'unified-route:' + g.id,
        msg: g.name + ' HAS NO UNIFIED TRUNK - its agentScript is "unified-agent", so /voice sends '
           + 'its calls to the unified project, but nothing there answers to garage id ' + g.id
           + '. Every call will die on connect and none will be logged. Create the inbound trunk '
           + 'and dispatch rule.',
      });
      continue;   // no trunk means the rule question is moot
    }

    // A trunk with no rule pointing at it is just as dead, and a rule naming the wrong agent
    // sends the call to a worker that will never claim it.
    const rule = (rules || []).find((r) => (r.trunkIds || []).includes(trunk.sipTrunkId));
    if (!rule) {
      issues.push({
        key: 'unified-route:' + g.id,
        msg: g.name + ' HAS A UNIFIED TRUNK BUT NO DISPATCH RULE - trunk ' + trunk.sipTrunkId
           + ' exists and nothing routes calls off it, so they will connect and then be dropped.',
      });
      continue;
    }
    const agents = ((rule.roomConfig && rule.roomConfig.agents) || []).map((a) => a.agentName);
    if (agents.length && !agents.includes('unified-agent')) {
      issues.push({
        key: 'unified-route:' + g.id,
        msg: g.name + ' DISPATCH RULE NAMES THE WRONG AGENT - rule ' + rule.sipDispatchRuleId
           + ' dispatches to "' + agents.join(', ') + '" but this garage runs unified-agent, so no '
           + 'worker will pick its calls up.',
      });
    }
  }
  return issues;
}

// A call "responded" if the agent took a real turn beyond the greeting OR any LLM model was billed.
function callResponded(call) {
  const t = Array.isArray(call.transcript) ? call.transcript : [];
  const aiTurns = t.filter((x) => /agent|assistant/i.test(`${x.speaker || x.role || ''}`)).length;
  const hasLLM = (call.metrics?.usage || []).some((u) => /gpt|gemma|gemini|claude|4o|4\.1/i.test(u.model || ''));
  return aiTurns >= 2 || hasLLM;
}
// The caller actually said something — so no-response is a real failure, not an instant hang-up.
function callerEngaged(call) {
  const t = Array.isArray(call.transcript) ? call.transcript : [];
  return t.some((x) => !/agent|assistant/i.test(`${x.speaker || x.role || ''}`) && `${x.text || ''}`.trim().length > 3);
}

// RESPONSE health — the fleet is answering calls but the agent isn't replying (greet-then-silence).
// The heartbeat can't see this: calls still connect and log, so volume looks normal.
async function checkResponseHealth() {
  const issues = [];
  const cfgs = await prisma.agentConfiguration.findMany({ select: { garageId: true, agentType: true } });
  const garages = await prisma.garage.findMany({ select: { id: true, name: true } });
  const nameById = new Map(garages.map((g) => [g.id, g.name]));
  const byType = { assist: [], automate: [] };
  for (const c of cfgs) (byType[c.agentType === 'assist' ? 'assist' : 'automate']).push(c.garageId);
  const since = new Date(Date.now() - RESP_WINDOW_MIN * 60000);

  for (const fleet of ['assist', 'automate']) {
    const ids = byType[fleet];
    if (!ids.length) continue;
    const calls = await prisma.call.findMany({
      where: { garageId: { in: ids }, createdAt: { gte: since } },
      select: { garageId: true, transcript: true, metrics: true, durationSeconds: true },
    });
    const engaged = calls.filter(callerEngaged);
    const silent = engaged.filter((c) => !callResponded(c));

    // The caller was never heard at all — see UNHEARD_* above.
    const longEnough = calls.filter((c) => (c.durationSeconds || 0) >= UNHEARD_MIN_SECS);
    const unheard = longEnough.filter((c) => !callerEngaged(c));
    if (longEnough.length >= UNHEARD_MIN_FAILS && unheard.length >= UNHEARD_MIN_FAILS
        && unheard.length >= longEnough.length * UNHEARD_FAIL_RATIO) {
      const names = [...new Set(unheard.map((c) => nameById.get(c.garageId) || c.garageId))].slice(0, 4);
      issues.push({
        key: `unheard:${fleet}`,
        msg: `${fleet.toUpperCase()} agents CANNOT HEAR CALLERS — ${unheard.length}/${longEnough.length} calls `
          + `over ${UNHEARD_MIN_SECS}s in the last ${RESP_WINDOW_MIN} min have NO caller speech in the `
          + `transcript at all. The calls connect and log, so every other check reads as healthy. `
          + `Suspect the last agent deploy (an exception in on_user_turn_completed silently drops `
          + `every caller turn) — check \`lk agent versions\` and roll back. Garages: ${names.join(', ')}.`,
      });
    }
    if (engaged.length >= RESP_MIN_FAILS && silent.length >= RESP_MIN_FAILS && silent.length >= engaged.length * RESP_FAIL_RATIO) {
      const names = [...new Set(silent.map((c) => nameById.get(c.garageId) || c.garageId))].slice(0, 4);
      issues.push({
        key: `silent:${fleet}`,
        msg: `${fleet.toUpperCase()} agents ANSWERING but NOT RESPONDING — ${silent.length}/${engaged.length} calls in the last ${RESP_WINDOW_MIN} min had the caller speak but got only a greeting (no LLM turn). Likely a bad agent deploy or LLM/tool fault. Garages: ${names.join(', ')}.`,
      });
    }
  }
  return issues;
}

// ---- UNANSWERED: Twilio connected the call, we have no record of it ----------------------
// The check that was missing on 2026-09-16. A bad agent deploy stripped the booking methods off
// the GarageHive adapter; In'n'out Norwich took 28 calls over two days that nobody answered, each
// sitting at a uniform ~34s until the caller gave up, and not one of them produced a Call row.
//
// Every other check here was blind to it, by construction:
//   heartbeat — needs a WHOLE FLEET at zero, and the rest of automate was busy
//   routing   — the trunk and dispatch rule were correct the entire time
//   response  — reads Call rows, and there were none to read
// From the database the garage simply looks quiet, and quiet is not an alert.
//
// So ask the only system that knows a customer actually rang: Twilio. Anything it connected for
// long enough to be a real call, with nothing logged against it, means the caller reached us and
// got nothing. It catches a dead agent, a broken dispatch rule, a SIP failure and a garage that
// has quietly stopped forwarding — all of which look identical from in here, and all of which
// need somebody to know today rather than at the end of the month.
const UNANS_WINDOW_MIN = 90;
// Below this a call is almost certainly a ring-out or an instant hang-up, which legitimately
// never becomes a Call row. Real conversations run far longer; the dead ones sat at 34s.
const UNANS_MIN_SECONDS = 20;
// Two could be coincidence — a caller hanging up twice, a burst of spam. Three is a pattern.
const UNANS_MIN_CALLS = 3;
// A garage that has logged a real conversation within this many hours is not hard down,
// whatever the last 90 minutes look like. Long enough to cover a quiet mid-morning, short
// enough that a genuine outage (EAC Telford went six days) still trips it.
const HARD_DOWN_ALIVE_HOURS = 4;
// A call this short never CONNECTED — nothing answered it. Above it, something picked up and
// the caller chose to leave, which is an ordinary thing callers do and not an outage.
//
// This distinction is the whole check. The agent deliberately does not log a call under 45s
// ("[portal] skip call log — 36s under 45s"), so from the database a run of short hang-ups is
// indistinguishable from a dead agent. Judging it on "max duration under 20s" called RPM
// Malvern hard down on 19 Sep while its agent was answering perfectly: the log shows the
// greeting spoken (TTS ttfb 0.429), the recording started, and the caller hanging up —
// CLIENT_INITIATED — after 6 to 15 seconds.
//
// Five seconds separates the two cleanly on every real case we have: Bracknell's genuine
// outage ran 0s, 0s, 0s, 3s because nothing ever answered, and EAC Telford's six-day outage
// sat at ~0s throughout.
const HARD_DOWN_MAX_SECONDS = 5;

const onlyDigits = (s) => String(s || '').replace(/[^0-9]/g, '').replace(/^0/, '44');

async function checkUnanswered() {
  const issues = [];
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) return issues;
  let twilioCalls;
  try {
    const twilio = require('twilio');
    const tw = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    twilioCalls = await tw.calls.list({
      startTimeAfter: new Date(Date.now() - UNANS_WINDOW_MIN * 60000), limit: 500,
    });
  } catch (e) {
    // Never let a Twilio hiccup take the other checks down with it.
    console.error('[watchdog] twilio lookup failed:', e.message);
    return issues;
  }

  const byNumber = new Map();
  // EVERY answered call, whatever its length. The 20s filter below is right for spotting a dial
  // that times out, but it is blind to an agent that is hard down: EAC Telford took 69 calls over
  // six days that all ended at ~0s, so nothing survived the filter, byNumber held no entry for
  // them at all, and the watchdog stayed silent through a total outage.
  const allByNumber = new Map();
  for (const c of twilioCalls) {
    if (c.status !== 'completed') continue;
    const k = onlyDigits(c.to);
    if (!allByNumber.has(k)) allByNumber.set(k, []);
    allByNumber.get(k).push(Number(c.duration || 0));
    if (Number(c.duration || 0) < UNANS_MIN_SECONDS) continue;
    if (!byNumber.has(k)) byNumber.set(k, []);
    byNumber.get(k).push(Number(c.duration || 0));
  }
  if (!byNumber.size && !allByNumber.size) return issues;

  const garages = await prisma.garage.findMany({
    where: { archivedAt: null, twilioNumber: { not: null } },
    select: { id: true, name: true, twilioNumber: true },
  });
  const since = new Date(Date.now() - UNANS_WINDOW_MIN * 60000);

  for (const g of garages) {
    if (SKIP_NAME_RE.test(g.name)) continue;
    const durations = byNumber.get(onlyDigits(g.twilioNumber));
    const allDur = allByNumber.get(onlyDigits(g.twilioNumber)) || [];

    // HARD DOWN: callers are connecting and not one call is becoming a conversation. There is
    // deliberately NO duration floor here — that floor is exactly what hid EAC Telford.
    //
    // But "nothing logged in the last 90 minutes" is NOT the same as "dead": a quiet window
    // with three callers hanging up during the greeting looks identical. That fired on Regal
    // Autosport and RPM Malvern on 18 Sep, both of which had handled a real call that morning.
    // A garage that logged a conversation in the last few hours is demonstrably alive, so the
    // wider lookback is what separates a dead agent from a quiet one. EAC Telford stays caught:
    // it logged nothing for six days.
    if (allDur.length >= UNANS_MIN_CALLS && Math.max.apply(null, allDur.concat([0])) < HARD_DOWN_MAX_SECONDS) {
      const aliveSince = new Date(Date.now() - HARD_DOWN_ALIVE_HOURS * 3600000);
      const loggedRecently = await prisma.call.count({ where: { garageId: g.id, createdAt: { gte: aliveSince } } });
      const loggedAll = loggedRecently === 0
        ? await prisma.call.count({ where: { garageId: g.id, createdAt: { gte: since } } })
        : 1;
      if (loggedAll === 0) {
        const avg = Math.round(allDur.reduce(function (a, b) { return a + b; }, 0) / allDur.length);
        issues.push({
          key: 'hard-down:' + g.id,
          msg: g.name + ' IS NOT ANSWERING AT ALL - Twilio connected ' + allDur.length
             + ' calls in the last ' + UNANS_WINDOW_MIN + ' min, every one ended at about '
             + avg + 's, and we logged NONE. Nothing became a conversation, so the agent is not '
             + 'picking up: check it is running and that its SIP trunk and dispatch rule exist.',
        });
        continue;   // one alert per garage, and this is the more serious of the two
      }
    }

    if (!durations || durations.length < UNANS_MIN_CALLS) continue;
    const logged = await prisma.call.count({ where: { garageId: g.id, createdAt: { gte: since } } });
    if (logged > 0) continue;   // something got through — not this failure
    // A tight cluster of identical durations is the dial timing out rather than callers
    // choosing to hang up, so say so: it points straight at the agent rather than the line.
    const sorted = durations.slice().sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const clustered = durations.filter((d) => Math.abs(d - median) <= 3).length >= durations.length * 0.6;
    issues.push({
      key: `unanswered:${g.id}`,
      msg: `${g.name} is TAKING CALLS THAT NOBODY ANSWERS — Twilio connected ${durations.length} calls of ${UNANS_MIN_SECONDS}s+ in the last ${UNANS_WINDOW_MIN} min and we logged NONE.`
         + (clustered ? ` Every one ended at about ${median}s, which is a dial timing out, not callers hanging up — check the agent is running and its dispatch rule is intact.` : '')
         + ' The caller is reaching us and getting nothing.',
    });
  }
  return issues;
}

// ---- state ----

/**
 * Does the config the agent READS match the config the portal SHOWS?
 *
 * The portal writes settings to Postgres; the voice and chat agents read a copy from DynamoDB.
 * Nothing reconciled the two, so a write that bypassed the config route left the agent serving
 * stale settings with no error anywhere. On 2026-08-19 Kestrels told a caller they do not sell
 * cars while their portal held sixteen FAQs saying otherwise, and Moto Oil Auto Centre Poole had
 * no DynamoDB record at all. Six garages were adrift and nobody could have known.
 *
 * Compares FAQ counts and the stored timestamp. Cheap, and it catches the whole class.
 */
async function checkConfigSync() {
  const issues = [];
  let client;
  try {
    const { DynamoDBClient, GetItemCommand } = require('@aws-sdk/client-dynamodb');
    const region = process.env.AWS_REGION || 'eu-west-2';
    const creds = process.env.AWS_ACCESS_KEY_ID
      ? { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY }
      : undefined;
    client = new DynamoDBClient(creds ? { region, credentials: creds } : { region });
    var GetItem = GetItemCommand;
  } catch (err) {
    console.error('[watchdog] config-sync check unavailable:', err.message);
    return issues;
  }

  const rows = await prisma.$queryRawUnsafe(`
    SELECT g.id, g.name, ac."updatedAt" AS cfg_updated,
           COALESCE(jsonb_array_length(ac.faqs), 0)::int AS faq_count
    FROM "Garage" g JOIN "AgentConfiguration" ac ON ac."garageId" = g.id
    WHERE g."archivedAt" IS NULL AND g."isTestAccount" = false`);

  for (const row of rows) {
    if (SKIP_NAME_RE.test(row.name)) continue;
    let item = null;
    try {
      const res = await client.send(new GetItem({
        TableName: 'AgentConfig',
        Key: { garageId: { S: row.id } },
      }));
      item = res.Item || null;
    } catch (err) {
      console.error(`[watchdog] dynamo read failed for ${row.name}:`, err.message);
      continue;   // a read error is not evidence of drift
    }

    if (!item) {
      issues.push({
        key: `cfgsync:${row.id}`,
        msg: `CONFIG MISSING: "${row.name}" has no agent config in DynamoDB at all — the agent is running on defaults, without their hours, FAQs or services. Re-save their agent config to push it.`,
      });
      continue;
    }

    let dynFaqs = 0;
    try {
      dynFaqs = (JSON.parse((item.configuration && item.configuration.S) || '{}').faqs || []).length;
    } catch (_) { /* unparseable config counts as drift below */ }

    const dynUpdated = item.updatedAt && item.updatedAt.S ? new Date(item.updatedAt.S) : null;
    const pgUpdated = row.cfg_updated ? new Date(row.cfg_updated) : null;
    // A minute of slack: the two writes are never simultaneous.
    const stale = pgUpdated && dynUpdated && pgUpdated.getTime() - dynUpdated.getTime() > 60000;

    if (dynFaqs !== row.faq_count || stale) {
      const bits = [];
      if (dynFaqs !== row.faq_count) bits.push(`portal has ${row.faq_count} FAQ(s), the agent has ${dynFaqs}`);
      if (stale) bits.push(`agent copy last written ${dynUpdated.toISOString().slice(0, 16).replace('T', ' ')}, portal changed since`);
      issues.push({
        key: `cfgsync:${row.id}`,
        msg: `CONFIG DRIFT: "${row.name}" — ${bits.join('; ')}. The agent is answering on older settings than the portal shows. Re-save their agent config to push it.`,
      });
    }
  }
  return issues;
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(map) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(map, null, 2)); } catch (e) { console.error('state write failed', e.message); }
}

// ---- alerting ----
/**
 * WhatsApp credential health.
 *
 * The silent failure this exists for: Meta does not need our token to DELIVER inbound webhooks,
 * so a garage whose credential has died still shows conversations arriving and looks perfectly
 * healthy. Only the REPLY fails, and a garage with no traffic that day produces no error at all.
 * Speedy Spanners sat dead from roughly 16 Sep until it was found by accident on the 22nd; four
 * more were dead alongside it and three others were counting down to an expiry nobody knew about.
 *
 * Two faults, both invisible until a customer complains:
 *   - the token is invalid (a USER token dies the moment that Facebook password changes, taking
 *     every garage sharing that login with it)
 *   - the token is valid but EXPIRING — Embedded Signup issues 60-day tokens, so every portal
 *     onboard carries a fuse lit on signup day
 *
 * Hourly, not every 5 minutes: this is a fact about configuration, not traffic, and nine Graph
 * calls a day is plenty to catch something that changes at most once per garage.
 */
const WA_EXPIRY_WARN_DAYS = [14, 7];

function graphGet(path) {
  return new Promise((resolve) => {
    https.get(`https://graph.facebook.com/v21.0${path}`, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ error: { message: 'unparseable' } }); } });
    }).on('error', (e) => resolve({ error: { message: e.message } }));
  });
}

async function checkWhatsAppTokens({ force = false } = {}) {
  const issues = [];
  // Once an hour — the watchdog itself runs every 5 minutes.
  if (!force && Number(londonParts().minute) >= 5) return issues;

  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!appId || !appSecret) {
    console.error('[watchdog] META_APP_ID/SECRET not set — cannot check WhatsApp tokens');
    return issues;
  }
  const appTok = `${appId}|${appSecret}`;

  const cons = await prisma.socialMediaConnection.findMany({
    where: { platform: 'whatsapp', isActive: true },
    select: { garageId: true, accessToken: true, whatsappPhoneNumberId: true },
  });

  for (const c of cons) {
    if (!c.whatsappPhoneNumberId || c.whatsappPhoneNumberId === 'pending_setup') continue;
    const g = await prisma.garage.findUnique({ where: { id: c.garageId }, select: { name: true, archivedAt: true } });
    if (!g || g.archivedAt) continue;

    // The credential the app would actually send with, not necessarily the stored one.
    const token = (process.env.META_SYSTEM_USER_TOKEN || '').trim() || c.accessToken;

    const dbg = await graphGet(`/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(appTok)}`);
    const info = dbg && dbg.data;
    if (!info || info.is_valid !== true) {
      const why = (info && info.error && info.error.message) || (dbg.error && dbg.error.message) || 'token reported invalid';
      issues.push({
        key: `wa-token:${c.garageId}`,
        msg: `${g.name}: WhatsApp token INVALID — the agent cannot reply on this number. ${why}`,
      });
      continue;
    }

    // A live probe as well as the debug view: the token can be valid in general and still have
    // lost access to THIS number, which reads identically to a healthy connection from outside.
    const probe = await graphGet(`/${c.whatsappPhoneNumberId}?fields=display_phone_number,quality_rating&access_token=${encodeURIComponent(token)}`);
    if (probe.error) {
      issues.push({
        key: `wa-token:${c.garageId}`,
        msg: `${g.name}: WhatsApp number ${c.whatsappPhoneNumberId} unreachable with the stored token — ${probe.error.message}`,
      });
      continue;
    }
    if (probe.quality_rating && ['RED', 'YELLOW'].includes(probe.quality_rating)) {
      issues.push({
        key: `wa-quality:${c.garageId}`,
        msg: `${g.name}: WhatsApp quality rating is ${probe.quality_rating} on ${probe.display_phone_number} — messaging limits are at risk.`,
      });
    }

    if (info.expires_at && info.expires_at > 0) {
      const days = Math.round((info.expires_at * 1000 - Date.now()) / 86400000);
      // A key per threshold, so the 14-day warning does not silence the 7-day one.
      for (const t of WA_EXPIRY_WARN_DAYS) {
        if (days <= t) {
          issues.push({
            key: `wa-expiry${t}:${c.garageId}`,
            msg: `${g.name}: WhatsApp token expires in ${days} day(s), on ${new Date(info.expires_at * 1000).toISOString().slice(0, 10)}. Generate a replacement with expiry Never before then.`,
          });
        }
      }
    }
  }
  return issues;
}

/**
 * Facebook / Instagram credential health.
 *
 * The same blind spot as WhatsApp, and it cost a real enquiry before anyone looked: on 2026-09-22
 * a customer asked Midlands Motorhome Hire about a Peak District trip, the agent composed a full
 * answer in seven seconds, and the send failed with code 190 because the page token had died in
 * the same password change that killed four WhatsApp tokens. The reply sat in our database
 * looking perfectly answered. Nobody was told; the customer just got silence.
 *
 * So two things are checked, because Messenger goes quiet in two different ways:
 *   - the page token is invalid (it is derived from a login, so it dies when that login changes)
 *   - the token is fine but OUR APP IS NO LONGER SUBSCRIBED to the page, which delivers no
 *     webhooks at all. Page grants are per-user-per-app and re-issuing a token while ticking only
 *     some pages silently revokes the others — that has scrambled connections before.
 */
const OUR_APP_ID = '1600229954436428';

async function checkMetaPages({ force = false } = {}) {
  const issues = [];
  if (!force && Number(londonParts().minute) >= 5) return issues;

  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!appId || !appSecret) return issues;
  const appTok = `${appId}|${appSecret}`;

  const cons = await prisma.socialMediaConnection.findMany({
    where: { platform: { in: ['facebook', 'instagram'] }, isActive: true },
    select: { garageId: true, platform: true, pageId: true, instagramAccountId: true, accessToken: true },
  });

  for (const c of cons) {
    const g = await prisma.garage.findUnique({ where: { id: c.garageId }, select: { name: true, archivedAt: true } });
    if (!g || g.archivedAt) continue;
    const who = `${g.name} (${c.platform})`;

    // What identifies the connection differs by platform, and getting this wrong pages someone
    // hourly about nothing: Facebook inbound is matched on pageId, but INSTAGRAM is matched on
    // instagramAccountId (webhooks/meta-instagram.ts). A null pageId on an Instagram row is
    // normal — @receptionmate has had one since May and works the way it is meant to.
    const routingId = c.platform === 'instagram' ? c.instagramAccountId : c.pageId;
    if (!routingId) {
      issues.push({
        key: `meta-page:${c.garageId}:${c.platform}`,
        msg: `${who}: connection is active but has no ${c.platform === 'instagram' ? 'instagram account id' : 'page id'} — nothing can route to it.`,
      });
      continue;
    }

    // Only Facebook pages have a subscribed_apps edge to check; Instagram rides on the linked
    // page's subscription, so there is nothing to ask it for.
    if (!c.pageId) continue;

    const dbg = await graphGet(`/debug_token?input_token=${encodeURIComponent(c.accessToken)}&access_token=${encodeURIComponent(appTok)}`);
    const info = dbg && dbg.data;
    if (!info || info.is_valid !== true) {
      const why = (info && info.error && info.error.message) || (dbg.error && dbg.error.message) || 'token reported invalid';
      issues.push({ key: `meta-token:${c.garageId}:${c.platform}`, msg: `${who}: page token INVALID — the agent composes replies that never reach the customer. ${why}` });
      continue;
    }

    const subs = await graphGet(`/${c.pageId}/subscribed_apps?access_token=${encodeURIComponent(c.accessToken)}`);
    if (subs.error) {
      issues.push({ key: `meta-token:${c.garageId}:${c.platform}`, msg: `${who}: page ${c.pageId} unreachable with the stored token — ${subs.error.message}` });
      continue;
    }
    if (!(subs.data || []).some((a) => String(a.id) === OUR_APP_ID)) {
      issues.push({ key: `meta-sub:${c.garageId}:${c.platform}`, msg: `${who}: our app is NOT subscribed to page ${c.pageId} — Meta is delivering no webhooks, so inbound messages never arrive.` });
    }

    if (info.expires_at && info.expires_at > 0) {
      const days = Math.round((info.expires_at * 1000 - Date.now()) / 86400000);
      for (const t of WA_EXPIRY_WARN_DAYS) {
        if (days <= t) {
          issues.push({ key: `meta-expiry${t}:${c.garageId}:${c.platform}`, msg: `${who}: page token expires in ${days} day(s), on ${new Date(info.expires_at * 1000).toISOString().slice(0, 10)}.` });
        }
      }
    }
  }
  return issues;
}

async function sendEmail(subject, text) {
  const key = process.env.MAILGUN_API_KEY, domain = process.env.MAILGUN_DOMAIN;
  const from = process.env.MAILGUN_FROM || `alerts@${domain}`;
  const base = (process.env.MAILGUN_API_BASE || 'https://api.mailgun.net').replace(/\/$/, '');
  if (!key || !domain) { console.error('mailgun not configured'); return; }
  const body = new URLSearchParams();
  body.set('from', `ReceptionMate Watchdog <${from}>`);
  ALERT_EMAILS.forEach((e) => body.append('to', e));
  body.set('subject', subject);
  body.set('text', text);
  const res = await fetch(`${base}/v3/${domain}/messages`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`api:${key}`).toString('base64') },
    body,
  });
  console.log('email', res.status, res.ok ? 'sent' : await res.text());
}
async function sendSms(text) {
  const sid = process.env.TWILIO_ACCOUNT_SID, token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) { console.error('twilio not configured'); return; }
  for (const to of ALERT_SMS) {
    const body = new URLSearchParams({ To: to, From: SMS_FROM, Body: text.slice(0, 1500) });
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    console.log('sms', to, res.status, res.ok ? 'sent' : await res.text());
  }
}

async function main() {
  // Print the WhatsApp credential findings and send nothing. For checking the check itself —
  // running the whole watchdog to see one function would page people.
  if (process.argv.includes('--wa-check')) {
    const found = [
      ...(await checkWhatsAppTokens({ force: true })),
      ...(await checkMetaPages({ force: true })),
    ];
    console.log(found.length ? found.map((i) => `${i.key}\n  ${i.msg}`).join('\n') : 'no messaging credential issues');
    await prisma.$disconnect();
    return;
  }

  if (TEST_MODE) {
    await sendEmail('✅ ReceptionMate Watchdog test', 'This is a test alert. Email + SMS delivery is working.');
    await sendSms('RM Watchdog test — alerts are working. You will get a message here if the agents go down.');
    await prisma.$disconnect();
    return;
  }

  const prev = loadState(); // { key: msg }
  const routing = await checkRouting();
  // Routing for unified garages, which checkRouting deliberately skips. Judged around the clock
  // like the other routing checks: a missing trunk is a fact about configuration, not about how
  // busy the phones are, and finding it at 6am is better than finding it at 9.
  const unifiedRouting = await checkUnifiedRouting();
  const configSync = await checkConfigSync();
  // Credential health is a fact about configuration too — judged around the clock, and a dead
  // token found at 6am is a dead token fixed before the first customer writes in.
  // Credential checks run once an hour, not every 5 minutes. On the other eleven runs they must
  // CARRY THE PREVIOUS STATE FORWARD rather than return nothing — an empty array here reads as
  // "the issue cleared", which sends a recovered email and then re-alerts on the next hourly run.
  // Hourly flapping, for exactly the faults that are least likely to fix themselves. Same trap the
  // heartbeat checks above avoid by carrying prior state outside business hours.
  const credentialHour = Number(londonParts().minute) < 5;
  const carry = (prefixes) => Object.entries(prev)
    .filter(([k]) => prefixes.some((pre) => k.startsWith(pre)))
    .map(([key, msg]) => ({ key, msg }));

  const waTokens = credentialHour
    ? await checkWhatsAppTokens()
    : carry(['wa-token:', 'wa-quality:', 'wa-expiry']);
  const metaPages = credentialHour
    ? await checkMetaPages()
    : carry(['meta-token:', 'meta-sub:', 'meta-page:', 'meta-expiry']);

  // Heartbeat only judged during business hours; outside hours, carry prior heartbeat state untouched
  // so we don't fire false "down"/"recovered" pings overnight.
  let heartbeat, responseHealth, unanswered;
  if (inBusinessHours()) {
    heartbeat = await checkHeartbeat();
    responseHealth = await checkResponseHealth();
    unanswered = await checkUnanswered();
  } else {
    heartbeat = Object.entries(prev).filter(([k]) => k.startsWith('heartbeat:')).map(([key, msg]) => ({ key, msg }));
    responseHealth = Object.entries(prev).filter(([k]) => k.startsWith('silent:')).map(([key, msg]) => ({ key, msg }));
    // hard-down: as well as unanswered:. Both come out of checkUnanswered, and carrying only
    // one of them meant every open outage vanished from `current` the moment business hours
    // ended — sending "recovered" about a line that was still dead, then alerting again the
    // next morning. A guaranteed flap, once a day, for exactly the faults that matter most.
    unanswered = Object.entries(prev)
      .filter(([k]) => k.startsWith('unanswered:') || k.startsWith('hard-down:'))
      .map(([key, msg]) => ({ key, msg }));
  }

  const current = {};
  [...heartbeat, ...responseHealth, ...unanswered, ...routing, ...unifiedRouting, ...configSync, ...waTokens, ...metaPages]
    .forEach((i) => { current[i.key] = i.msg; });

  // STICKY OUTAGES. An outage alert must not clear itself just because the evidence scrolled
  // out of the window. checkUnanswered asks "3+ Twilio calls in the last 90 minutes with none
  // logged" — so on a garage with sporadic traffic the third call ages out, the condition stops
  // being met, and we send "recovered" to a line that is still dead. Then the next caller pushes
  // it back over the threshold and we alert again. Bracknell and RPM Malvern flapped like that
  // all Saturday morning, which is what makes people stop reading these.
  //
  // Nothing recovered unless a call was actually LOGGED since. That is the only positive
  // evidence a garage is answering again; the absence of new failures is not evidence of
  // anything. Carrying the key forward keeps it out of BOTH newIssues and resolved, so it stays
  // silently open until it is genuinely fixed.
  for (const key of Object.keys(prev)) {
    if (key in current) continue;
    if (!key.startsWith('hard-down:') && !key.startsWith('unanswered:')) continue;
    const garageId = key.split(':')[1];
    const openedSince = new Date(Date.now() - UNANS_WINDOW_MIN * 60000);
    let logged = 0;
    try {
      logged = await prisma.call.count({ where: { garageId, createdAt: { gte: openedSince } } });
    } catch (e) {
      logged = 0;   // can't prove recovery -> assume still down rather than cry all-clear
    }
    if (logged === 0) {
      current[key] = prev[key];
      console.log(`[watchdog] ${key} held open — no call logged since, so nothing has recovered`);
    }
  }

  const newIssues = Object.entries(current).filter(([k]) => !(k in prev));
  const resolved = Object.keys(prev).filter((k) => !(k in current));

  console.log(`[watchdog] ${new Date().toISOString()} hours=${inBusinessHours()} active=${Object.keys(current).length} new=${newIssues.length} resolved=${resolved.length}`);

  if (newIssues.length) {
    const lines = newIssues.map(([, msg]) => `• ${msg}`).join('\n');
    await sendEmail(`🔴 ReceptionMate ALERT: ${newIssues.length} issue(s)`, `${lines}\n\nTime: ${new Date().toISOString()}`);
    await sendSms(`🔴 RM ALERT (${newIssues.length}): ` + newIssues.map(([, m]) => m.split(' — ')[0].split('.')[0]).join(' | '));
  }
  if (resolved.length) {
    const lines = resolved.map((k) => `• ${prev[k]}`).join('\n');
    await sendEmail(`✅ ReceptionMate: ${resolved.length} issue(s) recovered`, `${lines}\n\nTime: ${new Date().toISOString()}`);
    await sendSms(`✅ RM recovered (${resolved.length}): ` + resolved.map((k) => prev[k].split(' — ')[0].split('.')[0]).join(' | '));
  }

  saveState(current);
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error('[watchdog] error', e); try { await prisma.$disconnect(); } catch {} process.exit(1); });
