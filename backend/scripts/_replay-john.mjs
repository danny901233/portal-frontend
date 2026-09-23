/**
 * Replay of Great Hollands conversation cmudtzz2q022tn8oscu2s6oiv, 23 Sep 2026.
 * John's own session state and his own words, against the deployed agent.
 * Runs on 🔵 Test — GH v3, never on the live garage.
 */
import { PrismaClient } from '@prisma/client';
import { getChatAgentResponse, invalidateSessionCache } from '../dist/services/chatAgentV2.js';

process.env.CHAT_SCENARIO_RUN = '1';           // do not page anyone
const prisma = new PrismaClient();
const GARAGE = '844385bf-199d-426f-8b1e-caaa98cdc21e';   // 🔵 Test — GH v3

// John's session as it stood the moment he replied — the real record with the fields that
// turn itself added (the service it picked, the step it moved to) taken back off.
const JOHNS_STATE = {
  vrn: 'J8NKP', vrnConfirmed: true, vehicleMake: 'Seat', vehicleModel: 'Alhambra',
  step: 'need_service', intent: '', message: '', notes: '',
  sessionId: 'replay-john', bookingDate: '', bookingTime: '',
  contactPhone: '447700900199', contactPhoneSeeded: true,
  customerNameFirst: 'John', customerNameLast: 'Cole',
  greetedOutbound: true, outboundUpsellOffered: false,
  outboundServiceType: 'service', outboundRegistration: 'J8NKP',
  outboundDueDate: '2026-10-18',
  serviceAskPairs: 'full service then interim service; A service then B service; oil service then inspection service',
  servicePrice: '', preferredDate: '', servicesAvailable: [],
};
const HIS_WORDS = 'All ok for now thank you';

const run = async (n) => {
  const conv = await prisma.chatConversation.create({
    data: { garageId: GARAGE, platform: 'whatsapp', customerPhone: '447700900199',
            customerName: 'John', status: 'active', sessionState: JOHNS_STATE },
  });
  invalidateSessionCache(conv.id);
  const res = await getChatAgentResponse(GARAGE, HIS_WORDS, conv.id);
  const after = await prisma.chatConversation.findUnique({
    where: { id: conv.id }, select: { sessionState: true, needsAttention: true },
  });
  const st = after?.sessionState || {};
  const reply = String(res?.message || res?.reply || res?.text || JSON.stringify(res)).trim();
  console.log(`\n--- replay ${n} ---`);
  console.log(`  agent : ${reply}`);
  console.log(`  step=${st.step}  reminderOutcome=${st.reminderOutcome || '(none)'}  `
            + `serviceSelected=${st.serviceSelectedName || '(none)'}  `
            + `awaitingDatePreference=${st.awaitingDatePreference === true}`);
  await prisma.chatMessage.deleteMany({ where: { conversationId: conv.id } });
  await prisma.chatConversation.delete({ where: { id: conv.id } });
  return { reply, st };
};

console.log('WHAT ACTUALLY HAPPENED, 23 Sep 08:18');
console.log('  08:00  agent : ...reminder about your upcoming Service for J8NKP. Reply BOOK / QUOTE / CALL');
console.log('  08:18  John  : All ok for now thank you');
console.log('  08:19  agent : Hi John, thanks for getting back to us — have you any days or times in mind?');
console.log('         state : step=need_contact  serviceSelected=Carry out Full Service  awaitingDatePreference=true');
console.log('\nWHAT HAPPENS NOW (same state, same words, deployed agent)');
const outs = [];
for (let i = 1; i <= 3; i++) outs.push(await run(i));
const bad = outs.filter(o => /days? or times?|date in mind|which day|when would|any days/i.test(o.reply));
console.log(`\nasked for dates in ${bad.length} of ${outs.length} replays`);
console.log(`picked a service in ${outs.filter(o => o.st.serviceSelectedName).length} of ${outs.length}`);
await prisma.$disconnect();
