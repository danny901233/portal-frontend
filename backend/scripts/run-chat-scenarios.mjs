/**
 * Runs the 50 garage chat scenarios in chat-scenarios.mjs, N times each.
 *
 *   node -r dotenv/config scripts/run-chat-scenarios.mjs [runs] [--cat=booking] [--only=BOOK-03]
 *                                                       [--garage=<id>] [--quiet]
 *
 * Defaults to 4 runs per scenario (200 conversations) — expect ~20-30 minutes.
 * Use --cat or --only while iterating.
 *
 * SAFETY: refuses to run against a garage that is NOT a known test account, and prints a loud
 * warning if the target has messaging access enabled (i.e. a live WhatsApp line).
 *
 * NOTE ON GARAGE HIVE: the test accounts have no GH credentials, so live vehicle lookups fall
 * back to take_message. Scenarios that need a confirmed vehicle seed the session directly
 * (seed: 'midBooking') rather than relying on a real lookup.
 */
import { PrismaClient } from '@prisma/client';
import { getChatAgentResponse, invalidateSessionCache } from '../dist/services/chatAgentV2.js';
import { SCENARIOS, SEEDS } from './chat-scenarios.mjs';

const ALLOWED = {
  'd51dfa55-15d0-4d60-ad81-c675579d16f6': 'ReceptionMate Branch',
  '844385bf-199d-426f-8b1e-caaa98cdc21e': '🔵 Test — GH v3',
  'b5d47fed-9114-486e-af29-581f8d977724': '🔵 Test — Assist',
  '8e9548b0-9f23-4344-816e-a24605998759': '🔵 Test — Bookar',
};

const args = process.argv.slice(2);
const RUNS = Number(args.find(a => /^\d+$/.test(a)) || 4);
const CAT = (args.find(a => a.startsWith('--cat=')) || '').split('=')[1];
const ONLY = (args.find(a => a.startsWith('--only=')) || '').split('=')[1];
const QUIET = args.includes('--quiet');
const GARAGE_ID = (args.find(a => a.startsWith('--garage=')) || '').split('=')[1]
  || 'd51dfa55-15d0-4d60-ad81-c675579d16f6';

// Suppress the "a customer needs a human" alerts — see handleTakeMessage. Set before any
// conversation is driven, and read at call time, so the import order does not matter.
process.env.CHAT_SCENARIO_RUN = '1';

const prisma = new PrismaClient();
const rx = v => (v instanceof RegExp ? v : new RegExp(v, 'i'));

async function runScenario(s, i) {
  const seed = { ...(SEEDS[s.seed] || SEEDS.fresh) };
  const conv = await prisma.chatConversation.create({
    data: {
      garageId: GARAGE_ID, platform: 'whatsapp',
      customerPhone: '447700900199', platformUserId: `scen-${s.id}-${Date.now()}-${i}`,
      customerName: '', status: 'active', sessionState: seed,
    },
  });
  invalidateSessionCache(conv.id);
  const replies = [];
  try {
    for (const t of s.turns) {
      const r = await getChatAgentResponse(GARAGE_ID, t, conv.id, { phone: '447700900199' });
      replies.push((r?.content || '').replace(/\s+/g, ' ').trim());
    }
    const after = await prisma.chatConversation.findUnique({
      where: { id: conv.id }, select: { sessionState: true, needsAttention: true, agentPaused: true },
    });
    const last = replies[replies.length - 1] || '';
    const step = after?.sessionState?.step;
    const e = s.expect || {};
    const fails = [];
    if (!last) fails.push('empty reply');
    if (e.say && !rx(e.say).test(last)) fails.push(`missing expected: ${e.say}`);
    if (e.notSay && rx(e.notSay).test(last)) fails.push(`said forbidden: ${e.notSay}`);
    if (e.step && !e.step.includes(step)) fails.push(`step=${step} not in [${e.step}]`);
    if (e.flagged !== undefined && !!after?.needsAttention !== e.flagged) fails.push(`needsAttention=${after?.needsAttention} want ${e.flagged}`);
    if (e.paused !== undefined && !!after?.agentPaused !== e.paused) fails.push(`agentPaused=${after?.agentPaused} want ${e.paused}`);
    return { ok: fails.length === 0, fails, last, step, flagged: !!after?.needsAttention };
  } finally {
    await prisma.chatMessage.deleteMany({ where: { conversationId: conv.id } }).catch(() => {});
    await prisma.chatConversation.delete({ where: { id: conv.id } }).catch(() => {});
  }
}

(async () => {
  const g = await prisma.garage.findUnique({
    where: { id: GARAGE_ID },
    select: { name: true, hasMessagingAccess: true, agentConfiguration: { select: { agentScript: true, agentType: true } } },
  });
  if (!g) throw new Error('garage not found');
  if (!ALLOWED[GARAGE_ID]) throw new Error(`REFUSING: ${g.name} is not a known test account`);
  console.log(`target : ${g.name}  (${g.agentConfiguration?.agentScript})`);
  if (g.hasMessagingAccess) console.log('WARNING: this garage has messaging access ON — it is a live line. Scenarios create and delete their own conversations, but real inbound messages may interleave.');

  let list = SCENARIOS;
  if (CAT) list = list.filter(s => s.cat === CAT);
  if (ONLY) list = list.filter(s => s.id === ONLY);
  console.log(`scenarios: ${list.length}   runs each: ${RUNS}   total conversations: ${list.length * RUNS}\n`);

  const results = [];
  for (const s of list) {
    let pass = 0; const seen = [];
    for (let i = 1; i <= RUNS; i++) {
      try {
        const r = await runScenario(s, i);
        if (r.ok) pass++; else seen.push(r);
      } catch (err) {
        seen.push({ fails: [`ERROR ${String(err.message).split('\n')[0]}`], last: '', step: '?' });
      }
    }
    results.push({ s, pass });
    const mark = pass === RUNS ? 'PASS' : pass === 0 ? 'FAIL' : 'FLAKY';
    console.log(`${mark.padEnd(5)} ${s.id.padEnd(9)} ${pass}/${RUNS}  ${s.desc}`);
    if (!QUIET && seen.length) {
      console.log(`        why: ${seen[0].fails.join(' | ')}`);
      console.log(`        got: ${(seen[0].last || '(none)').slice(0, 130)}`);
    }
  }

  console.log('\n──────── SUMMARY BY CATEGORY ────────');
  const cats = [...new Set(results.map(r => r.s.cat))];
  for (const c of cats) {
    const rs = results.filter(r => r.s.cat === c);
    const full = rs.filter(r => r.pass === RUNS).length;
    const zero = rs.filter(r => r.pass === 0).length;
    console.log(`  ${c.padEnd(14)} ${String(full).padStart(2)}/${rs.length} clean   ${zero} failing   ${rs.length - full - zero} flaky`);
  }
  const clean = results.filter(r => r.pass === RUNS).length;
  const failing = results.filter(r => r.pass === 0);
  console.log(`\nTOTAL: ${clean}/${results.length} scenarios clean across all ${RUNS} runs`);
  if (failing.length) console.log(`FAILING: ${failing.map(r => r.s.id).join(', ')}`);
  const flaky = results.filter(r => r.pass > 0 && r.pass < RUNS);
  if (flaky.length) console.log(`FLAKY:   ${flaky.map(r => `${r.s.id}(${r.pass}/${RUNS})`).join(', ')}`);
  await prisma.$disconnect();
  process.exit(failing.length ? 1 : 0);
})();
