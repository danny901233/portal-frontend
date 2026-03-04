const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const garageId = 'd51dfa55-15d0-4d60-ad81-c675579d16f6';

  console.log('Checking Facebook connection for garage:', garageId);

  const connection = await prisma.socialMediaConnection.findFirst({
    where: {
      garageId,
      platform: 'facebook',
    },
  });

  if (!connection) {
    console.log('❌ No Facebook connection found');
    return;
  }

  console.log('✓ Connection found:');
  console.log('  ID:', connection.id);
  console.log('  Platform:', connection.platform);
  console.log('  Page ID:', connection.pageId);
  console.log('  Is Active:', connection.isActive);
  console.log('  Has Access Token:', !!connection.accessToken);
  console.log('  Access Token (first 20 chars):', connection.accessToken?.substring(0, 20));
  console.log('  Created:', connection.createdAt);
  console.log('  Updated:', connection.updatedAt);

  // Check if there are any conversations
  const conversations = await prisma.chatConversation.findMany({
    where: {
      garageId,
      platform: 'facebook',
    },
    include: {
      messages: {
        take: 1,
        orderBy: { createdAt: 'desc' },
      },
    },
  });

  console.log('\n📊 Facebook Conversations:', conversations.length);
  if (conversations.length > 0) {
    console.log('Most recent conversation:');
    console.log('  ID:', conversations[0].id);
    console.log('  Last Message:', conversations[0].lastMessageAt);
    console.log('  Status:', conversations[0].status);
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
