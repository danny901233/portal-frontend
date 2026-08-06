const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const GARAGE_ID = 'd51dfa55-15d0-4d60-ad81-c675579d16f6';
const PHONE = '+639452660548';

(async () => {
  // Delete all old conversations for Gabriel on this garage
  const convs = await p.chatConversation.findMany({
    where: { garageId: GARAGE_ID, customerPhone: PHONE },
    select: { id: true, sessionState: true }
  });
  for (const c of convs) {
    const s = c.sessionState || {};
    console.log('Found conv:', c.id, '| step:', s.step, '| outboundReg:', s.outboundRegistration);
    await p.chatMessage.deleteMany({ where: { conversationId: c.id } });
    await p.chatConversation.delete({ where: { id: c.id } });
    console.log('Deleted:', c.id);
  }

  // Neutralize outbound contacts so they don't re-seed the session on next message
  const phoneVariants = [PHONE, PHONE.replace(/^\+/, '')];
  const outbounds = await p.outboundContact.findMany({
    where: {
      garageId: GARAGE_ID,
      phone: { in: phoneVariants },
      status: { in: ['sent', 'delivered', 'read', 'replied'] },
    },
    select: { id: true, status: true, campaignId: true },
  });
  for (const ob of outbounds) {
    await p.outboundContact.update({
      where: { id: ob.id },
      data: { status: 'replied' },
    });
    console.log(`Neutralized outbound contact ${ob.id} (was: ${ob.status}, campaign: ${ob.campaignId})`);
  }
  if (outbounds.length === 0) {
    console.log('No active outbound contacts found for this number');
  }

  console.log('Done — fresh inbound conversation will be created on next reply');
  await p.$disconnect();
})().catch(function(e) { console.error(e.message); process.exit(1); });
