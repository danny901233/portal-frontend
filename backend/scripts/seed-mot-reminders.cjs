/**
 * Seeds mot_reminder_1 / mot_reminder_2 onto every Connect garage with a live WhatsApp
 * connection, then submits them to Meta for approval.
 *
 * Copied from Speedy Spanners, but reshaped to the 5-variable house order so the agent's name
 * is a PLACEHOLDER rather than baked into the text. The source templates say "Its Tom from
 * {{2}}" with the name hard-coded, which cannot be reused by a garage whose agent is Gemma or
 * Sophie. {{2}} is now agent_name, filled at send time from AgentConfiguration.agentName.
 *
 * The source templates also carry no {{N}}_field assignments, so reminderScheduler would have
 * sent them with zero parameters. Both field maps are written here.
 *
 *   DRY RUN (default):  node scripts/seed-mot-reminders.cjs
 *   ARMED:              ARMED=1 node scripts/seed-mot-reminders.cjs
 */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const ARMED = process.env.ARMED === '1';
const GRAPH = 'https://graph.facebook.com/v18.0';

const TARGETS = [
  'ReceptionMate Branch',
  'ReceptionMate Demo',
  'EAC Telford',
  'Ecotest MOT & Service Centre',
  'Great Hollands MOT & Service Centre',
  'JDK Automotive',
  'L P Autos Ltd',
];

// {{1}} customer, {{2}} agent, {{3}} branch, {{4}} registration, {{5}} due date — the order
// reminderScheduler's fallback already hard-codes, so staged and unstaged sends agree.
const VARIABLE_SAMPLES = {
  '{{1}}': 'John Smith', '{{1}}_field': 'customer_name',
  '{{2}}': 'Sophie', '{{2}}_field': 'agent_name',
  '{{3}}': 'City Garage', '{{3}}_field': 'garage_name',
  '{{4}}': 'AB12 CDE', '{{4}}_field': 'registration',
  '{{5}}': '15-Apr-26', '{{5}}_field': 'mot_due_date',
};

const TEMPLATES = [
  {
    name: 'mot_reminder_1',
    // "Thanks, Tom" is dropped rather than repeated as a second {{2}} — Meta's validator is
    // unreliable about a positional parameter used twice, and this is going to seven accounts.
    bodyText: "Hi {{1}}, it's {{2}} from {{3}}. Your car {{4}} is due for its MOT on {{5}}, would you like to book that in? Thanks!",
  },
  {
    name: 'mot_reminder_2',
    bodyText: "Hi {{1}}, it's {{2}} from {{3}}, just to follow up on my previous message. Your car {{4}} is due for its MOT on {{5}}, would you like me to book that in? If you've already got it sorted please let me know and I will remove you from our reminders.",
  },
];

const CATEGORY = 'MARKETING';
const LANGUAGE = 'en_GB';

function tokens(stored) {
  const shared = (process.env.META_SYSTEM_USER_TOKEN || '').trim();
  return [...new Set([shared, (stored || '').trim()].filter(Boolean))];
}

async function resolveWabaId(conn) {
  // pageId is where the WABA id is stashed for whatsapp rows (see routes/templates.ts).
  if (conn.pageId) return conn.pageId;
  for (const tok of tokens(conn.accessToken)) {
    try {
      const r = await fetch(
        `${GRAPH}/${conn.whatsappPhoneNumberId}?fields=whatsapp_business_account`,
        { headers: { Authorization: `Bearer ${tok}` } },
      );
      const d = await r.json();
      if (d.whatsapp_business_account?.id) return d.whatsapp_business_account.id;
    } catch { /* try the next token */ }
  }
  return null;
}

async function findRemoteByName(wabaId, name, toks) {
  for (const tok of toks) {
    try {
      const r = await fetch(
        `${GRAPH}/${wabaId}/message_templates?name=${encodeURIComponent(name)}`,
        { headers: { Authorization: `Bearer ${tok}` } },
      );
      const d = await r.json();
      const hit = (d.data || []).find((t) => t.name === name && t.language === LANGUAGE);
      if (hit) return hit;
    } catch { /* try the next token */ }
  }
  return null;
}

async function submit(wabaId, tmpl, toks) {
  const payload = {
    name: tmpl.name,
    language: LANGUAGE,
    category: CATEGORY,
    components: [{
      type: 'BODY',
      text: tmpl.bodyText,
      example: { body_text: [['John Smith', 'Sophie', 'City Garage', 'AB12 CDE', '15-Apr-26']] },
    }],
  };
  let last = null;
  for (const tok of toks) {
    const r = await fetch(`${GRAPH}/${wabaId}/message_templates`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const d = await r.json();
    if (r.ok && d.id) return { ok: true, id: d.id, status: d.status || 'PENDING' };
    last = d.error || d;
    // A name already on this WABA means a sibling branch got there first — adopt it.
    const existing = await findRemoteByName(wabaId, tmpl.name, toks);
    if (existing) return { ok: true, id: existing.id, status: existing.status, adopted: true };
  }
  return { ok: false, error: last };
}

(async () => {
  console.log(`\n=== mot_reminder_1/2 seed — ${ARMED ? 'ARMED' : 'DRY RUN'} ===\n`);
  const wabaCache = new Map();
  const summary = [];

  for (const name of TARGETS) {
    const garage = await prisma.garage.findFirst({
      where: { name },
      select: {
        id: true, name: true, hasMessagingAccess: true,
        agentConfiguration: { select: { agentName: true } },
      },
    });
    if (!garage) { console.log(`SKIP ${name}: no such garage`); continue; }
    if (!garage.hasMessagingAccess) { console.log(`SKIP ${name}: messaging not enabled`); continue; }

    const conn = await prisma.socialMediaConnection.findFirst({
      where: { garageId: garage.id, platform: 'whatsapp', isActive: true },
      orderBy: { isPrimary: 'desc' },
    });
    if (!conn?.whatsappPhoneNumberId) { console.log(`SKIP ${name}: no live WhatsApp connection`); continue; }

    const wabaId = await resolveWabaId(conn);
    if (!wabaId) { console.log(`SKIP ${name}: could not resolve WABA`); continue; }
    const shared = wabaCache.has(wabaId) ? ` (shares WABA with ${wabaCache.get(wabaId)})` : '';
    if (!wabaCache.has(wabaId)) wabaCache.set(wabaId, garage.name);

    const agent = garage.agentConfiguration?.agentName || '(unset → Leah)';
    console.log(`\n${garage.name} — agent ${agent} — WABA ${wabaId}${shared}`);

    for (const tmpl of TEMPLATES) {
      const existing = await prisma.messageTemplate.findFirst({
        where: { garageId: garage.id, name: tmpl.name },
      });
      if (existing && ['pending', 'approved'].includes(existing.status)) {
        console.log(`  = ${tmpl.name}: already ${existing.status} — leaving alone`);
        summary.push([garage.name, tmpl.name, `skipped (${existing.status})`]);
        continue;
      }
      if (!ARMED) {
        console.log(`  + ${tmpl.name}: would ${existing ? 'update + resubmit' : 'create + submit'}`);
        summary.push([garage.name, tmpl.name, 'would submit']);
        continue;
      }

      const data = {
        garageId: garage.id, name: tmpl.name, category: CATEGORY, templateType: 'mot',
        language: LANGUAGE, bodyText: tmpl.bodyText, variableSamples: VARIABLE_SAMPLES,
        headerType: 'none', buttonType: 'none', status: 'draft',
      };
      const row = existing
        ? await prisma.messageTemplate.update({ where: { id: existing.id }, data })
        : await prisma.messageTemplate.create({ data });

      const res = await submit(wabaId, tmpl, tokens(conn.accessToken));
      if (res.ok) {
        await prisma.messageTemplate.update({
          where: { id: row.id },
          data: { metaTemplateId: res.id, status: (res.status || 'PENDING').toLowerCase() },
        });
        console.log(`  ✓ ${tmpl.name}: ${res.adopted ? 'adopted existing' : 'submitted'} ${res.id} (${res.status})`);
        summary.push([garage.name, tmpl.name, res.adopted ? 'adopted' : 'submitted']);
      } else {
        console.log(`  ✗ ${tmpl.name}: ${JSON.stringify(res.error)}`);
        summary.push([garage.name, tmpl.name, `FAILED: ${res.error?.message || 'unknown'}`]);
      }
    }
  }

  console.log('\n=== summary ===');
  for (const [g, t, r] of summary) console.log(`${g.padEnd(38)} ${t.padEnd(16)} ${r}`);
  await prisma.$disconnect();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
