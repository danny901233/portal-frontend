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
      select: { garageId: true, transcript: true, metrics: true },
    });
    const engaged = calls.filter(callerEngaged);
    const silent = engaged.filter((c) => !callResponded(c));
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
  if (TEST_MODE) {
    await sendEmail('✅ ReceptionMate Watchdog test', 'This is a test alert. Email + SMS delivery is working.');
    await sendSms('RM Watchdog test — alerts are working. You will get a message here if the agents go down.');
    await prisma.$disconnect();
    return;
  }

  const prev = loadState(); // { key: msg }
  const routing = await checkRouting();
  const configSync = await checkConfigSync();

  // Heartbeat only judged during business hours; outside hours, carry prior heartbeat state untouched
  // so we don't fire false "down"/"recovered" pings overnight.
  let heartbeat, responseHealth;
  if (inBusinessHours()) {
    heartbeat = await checkHeartbeat();
    responseHealth = await checkResponseHealth();
  } else {
    heartbeat = Object.entries(prev).filter(([k]) => k.startsWith('heartbeat:')).map(([key, msg]) => ({ key, msg }));
    responseHealth = Object.entries(prev).filter(([k]) => k.startsWith('silent:')).map(([key, msg]) => ({ key, msg }));
  }

  const current = {};
  [...heartbeat, ...responseHealth, ...routing, ...configSync].forEach((i) => { current[i.key] = i.msg; });

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
