require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const conversations = await prisma.chatConversation.findMany({
    where: {
      platform: 'facebook',
    },
    include: {
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 5,
      },
    },
    orderBy: { lastMessageAt: 'desc' },
    take: 1,
  });

  if (conversations.length === 0) {
    console.log('No conversations found');
    return;
  }

  const conv = conversations[0];
  console.log('Latest Facebook conversation:');
  console.log('ID:', conv.id);
  console.log('Last message:', conv.lastMessageAt);
  console.log('\nMessages (most recent first):');
  
  for (const msg of conv.messages) {
    console.log(`\n[${msg.role}] ${msg.createdAt}`);
    console.log(msg.content);
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
