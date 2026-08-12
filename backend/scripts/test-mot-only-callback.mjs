/**
 * Regression test — MOT-only must end in a callback, not a booking loop.
 *
 * Guards the bug seen on Great Hollands 2026-08-12: a customer asked for an MOT on its own,
 * the agent correctly promised a Service Advisor callback and asked for their details, then —
 * once they gave them — reverted to offering services and never called take_message. The
 * culprit was the side-question nudge injecting "then smoothly continue selecting a service",
 * which overrode the garage's own rule.
 *
 * Runs against the 🔵 Test — GH v3 garage ONLY (receptionmate-agent-v3, messaging access OFF,
 * and it already carries the "do not book MOT-only" rule). Never point this at a live garage.
 *
 * The failure is probabilistic — it is an LLM compliance issue, not a deterministic branch —
 * so a single green run proves little. This runs the scenario N times and reports a pass rate.
 *
 *   cd ~/portal-frontend/backend && node scripts/test-mot-only-callback.mjs [runs]
 */
import { PrismaClient } from '@prisma/client';
import { getChatAgentResponse, invalidateSessionCache } from '../dist/services/chatAgentV2.js';

const GARAGE_ID = '844385bf-199d-426f-8b1e-caaa98cdc21e'; // 🔵 Test — GH v3
const RUNS = Number(process.argv[2] || 5);

// Mirrors a real Garage Hive catalogue: every MOT is bundled, there is NO standalone MOT.
// That is what makes "just the MOT" unbookable and a callback the only correct outcome.
const SERVICES = [
  { name: 'Carry out Full Service With a MOT Test', service_price_id: '5907' },
  { name: 'Carry out Interim Service with a MOT Test', service_price_id: '5911' },
  { name: 'Oil & Filter Service with MOT', service_price_id: '5757' },
  { name: 'Carry out Full Service', service_price_id: '5910' },
  { name: 'Carry out Interim Service', service_price_id: '5917' },
];

// Picks up mid-booking, exactly where the live failure happened: vehicle already confirmed,
// services already loaded, sitting at need_service.
const SEED_SESSION = {
  step: 'need_service',
  vrn: 'V20ALA',
  vrnConfirmed: true,
  vehicleMake: 'Land Rover',
  vehicleModel: 'Range Rover Evoque',
  sessionId: 'test-session-mot-only',
  servicesAvailable: SERVICES,
  intent: '', notes: '', servicePrice: '',
};

const TURNS = [
  'What dates have you got ?',      // a question at need_service — fires the side-question nudge
  'Just the MOT',                   // declines a service; garage rule => callback, not a booking
  'Dan Test and 07700900123',       // hands over the details it asked for => must take_message
];

const prisma = new PrismaClient();

async function runOnce(i) {
  const conv = await prisma.chatConversation.create({
    data: {
      garageId: GARAGE_ID, platform: 'whatsapp',
      customerPhone: '447700900123', platformUserId: `motonly-test-${Date.now()}-${i}`,
      customerName: 'Dan Test', status: 'active', sessionState: SEED_SESSION,
    },
  });
  invalidateSessionCache(conv.id);
  const replies = [];
  try {
    for (const t of TURNS) {
      const r = await getChatAgentResponse(GARAGE_ID, t, conv.id, { phone: '447700900123', name: 'Dan Test' });
      replies.push((r?.content || '').replace(/\s+/g, ' ').trim());
    }
    const after = await prisma.chatConversation.findUnique({ where: { id: conv.id }, select: { sessionState: true } });
    const step = after?.sessionState?.step;
    // take_message is the only thing that sets MESSAGE_ONLY, so the step is the assertion.
    const passed = step === 'message_only';
    return { passed, step, last: replies[replies.length - 1] || '(no reply)' };
  } finally {
    await prisma.chatMessage.deleteMany({ where: { conversationId: conv.id } }).catch(() => {});
    await prisma.chatConversation.delete({ where: { id: conv.id } }).catch(() => {});
  }
}

/**
 * Scenario 2 — giving your name mid-booking must NOT rewind the conversation.
 *
 * save_caller_name is written for the start of a chat (name -> ask for the reg), but the model
 * also calls it when a customer volunteers their name later, e.g. after we ask for details to
 * arrange a callback. It used to reset the step to need_vrn and re-greet from scratch, throwing
 * away the confirmed vehicle and the loaded services — "the agent forgot the conversation".
 *
 * Unlike scenario 1 this is a state invariant, not model compliance, so it should be 100%.
 */
async function runNameMidBooking(i) {
  const conv = await prisma.chatConversation.create({
    data: {
      garageId: GARAGE_ID, platform: 'whatsapp',
      customerPhone: '447700900124', platformUserId: `namerewind-test-${Date.now()}-${i}`,
      customerName: '', status: 'active', sessionState: SEED_SESSION,
    },
  });
  invalidateSessionCache(conv.id);
  try {
    const r = await getChatAgentResponse(GARAGE_ID, 'Dan Test', conv.id, { phone: '447700900124' });
    const after = await prisma.chatConversation.findUnique({ where: { id: conv.id }, select: { sessionState: true } });
    const s = after?.sessionState || {};
    const passed = s.step !== 'need_vrn' && s.vrnConfirmed === true && !!s.vrn;
    return { passed, step: s.step, vrnConfirmed: s.vrnConfirmed, vrn: s.vrn,
             reply: (r?.content || '').replace(/\s+/g, ' ').trim() };
  } finally {
    await prisma.chatMessage.deleteMany({ where: { conversationId: conv.id } }).catch(() => {});
    await prisma.chatConversation.delete({ where: { id: conv.id } }).catch(() => {});
  }
}

(async () => {
  const g = await prisma.garage.findUnique({
    where: { id: GARAGE_ID },
    select: { name: true, hasMessagingAccess: true, agentConfiguration: { select: { agentScript: true } } },
  });
  if (!g) throw new Error('test garage not found');
  if (g.hasMessagingAccess) throw new Error(`REFUSING: ${g.name} has messaging access ON — not a safe test target`);
  console.log(`target: ${g.name} (${g.agentConfiguration?.agentScript})  runs: ${RUNS}\n`);

  console.log('SCENARIO 1 — "just the MOT" must end in a callback (take_message)');
  let pass1 = 0;
  for (let i = 1; i <= RUNS; i++) {
    try {
      const r = await runOnce(i);
      if (r.passed) pass1++;
      console.log(`  run ${i}: ${r.passed ? 'PASS' : 'FAIL'}  step=${r.step}`);
      console.log(`     final reply: ${r.last.slice(0, 140)}`);
    } catch (e) {
      console.log(`  run ${i}: ERROR ${String(e.message).split('\n')[0]}`);
    }
  }

  console.log('\nSCENARIO 2 — giving a name mid-booking must not rewind to need_vrn');
  let pass2 = 0;
  for (let i = 1; i <= RUNS; i++) {
    try {
      const r = await runNameMidBooking(i);
      if (r.passed) pass2++;
      console.log(`  run ${i}: ${r.passed ? 'PASS' : 'FAIL'}  step=${r.step} vrnConfirmed=${r.vrnConfirmed} vrn=${r.vrn || '(cleared)'}`);
      console.log(`     reply: ${r.reply.slice(0, 140)}`);
    } catch (e) {
      console.log(`  run ${i}: ERROR ${String(e.message).split('\n')[0]}`);
    }
  }

  console.log(`\nRESULT  scenario 1 (callback):      ${pass1}/${RUNS}`);
  console.log(`RESULT  scenario 2 (no rewind):     ${pass2}/${RUNS}`);
  const ok = pass1 === RUNS && pass2 === RUNS;
  console.log(ok ? '\nAll green.' : '\nNot all green — see the failing runs above.');
  await prisma.$disconnect();
  process.exit(ok ? 0 : 1);
})();
