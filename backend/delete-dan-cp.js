const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function deleteUserAndBusiness(email) {
  console.log(`\n🔍 Looking up user: ${email}`);
  try {
    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, garageAccessIds: true },
    });
    if (!user) { console.log('❌ User not found — nothing to delete'); return; }
    console.log(`✓ Found user: ${user.id}`);
    console.log(`  Garage IDs: ${user.garageAccessIds.join(', ') || '(none)'}`);

    const garages = await prisma.garage.findMany({
      where: { id: { in: user.garageAccessIds } },
      include: { business: true, agentConfiguration: true },
    });
    console.log(`\n📊 ${garages.length} garage(s):`);
    const businessIds = new Set();
    for (const g of garages) {
      console.log(`  • ${g.name} (${g.id}) — business: ${g.business?.name || 'none'}`);
      if (g.businessId) businessIds.add(g.businessId);
    }

    console.log(`\n🗑️  Deleting...`);
    for (const g of garages) {
      await prisma.callFeedback.deleteMany({ where: { call: { garageId: g.id } } });
      await prisma.chatMessage.deleteMany({ where: { conversation: { garageId: g.id } } });
      await prisma.chatConversation.deleteMany({ where: { garageId: g.id } });
      await prisma.call.deleteMany({ where: { garageId: g.id } });
      await prisma.customer.deleteMany({ where: { garageId: g.id } });
      await prisma.invoice.deleteMany({ where: { garageId: g.id } });
      await prisma.smsBookingLink.deleteMany({ where: { garageId: g.id } });
      await prisma.agentKnowledgeDocument.deleteMany({ where: { garageId: g.id } });
      await prisma.socialMediaConnection.deleteMany({ where: { garageId: g.id } });
      if (g.agentConfiguration) {
        await prisma.agentConfiguration.delete({ where: { garageId: g.id } });
      }
      await prisma.garage.delete({ where: { id: g.id } });
      console.log(`  ✓ Garage: ${g.name}`);
    }
    for (const bid of businessIds) {
      const b = await prisma.business.findUnique({ where: { id: bid }, include: { garages: true } });
      if (b && b.garages.length === 0) {
        await prisma.business.delete({ where: { id: bid } });
        console.log(`  ✓ Business: ${b.name}`);
      }
    }
    await prisma.user.delete({ where: { id: user.id } });
    console.log(`  ✓ User: ${email}`);
    console.log(`\n✅ Done.`);
  } catch (e) { console.error('❌', e); throw e; } finally { await prisma.$disconnect(); }
}

deleteUserAndBusiness('dan@creativeproperty.uk').catch((e) => { console.error('Fatal:', e); process.exit(1); });
