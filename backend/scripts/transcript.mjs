/**
 * Print the actual conversation for a few reminder flows, so we can judge whether it reads like a
 * person rather than whether it passes a regex.
 */
import { PrismaClient } from '@prisma/client';
import { getChatAgentResponse, invalidateSessionCache } from '../dist/services/chatAgentV2.js';
import { SEEDS } from './chat-scenarios.mjs';

process.env.CHAT_SCENARIO_RUN = '1';
const prisma = new PrismaClient();
const GARAGE = 'd51dfa55-15d0-4d60-ad81-c675579d16f6';

const CONVERSATIONS = [
  ['Hi', 'Yes please', 'What dates the soonest', 'mornings would be better', "no that's all thanks"],
  ['Yes please', "I'm not really sure, what have you got?", 'ok Tuesday then', 'can you look at the brakes too'],
  ['Yes please', 'how much is it going to be?', 'next week if you can'],
];

for (const [n, turns] of CONVERSATIONS.entries()) {
  const conv = await prisma.chatConversation.create({
    data: {
      garageId: GARAGE, platform: 'whatsapp', customerPhone: '447700900199',
      platformUserId: `transcript-${n}-${Date.now()}`, customerName: '', status: 'active',
      sessionState: { ...SEEDS.reminderNoSlots },
    },
  });
  invalidateSessionCache(conv.id);
  console.log(`\n${'═'.repeat(78)}\nCONVERSATION ${n + 1}\n${'═'.repeat(78)}`);
  console.log(`  agent  › Hi Sarah, thanks for getting back to us — have you any days or times in mind?`);
  try {
    for (const t of turns) {
      const r = await getChatAgentResponse(GARAGE, t, conv.id, { phone: '447700900199' });
      console.log(`\n  SARAH  › ${t}`);
      console.log(`  agent  › ${(r?.content || '(empty)').replace(/\s+/g, ' ').trim()}`);
    }
    const after = await prisma.chatConversation.findUnique({
      where: { id: conv.id }, select: { sessionState: true, needsAttention: true },
    });
    console.log(`\n  [flagged for the team: ${after?.needsAttention} | note: ${after?.sessionState?.message || '—'}]`);
  } finally {
    await prisma.chatMessage.deleteMany({ where: { conversationId: conv.id } }).catch(() => {});
    await prisma.chatConversation.delete({ where: { id: conv.id } }).catch(() => {});
  }
}
await prisma.$disconnect();
