require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // Configuration
  const pageId = '224576834077659';
  const pageName = 'ReceptionMate';
  const accessToken = 'EAAWvZApHZBPUwBQp22ZCQOsSZBKJohLHeILJDZAYOCsjUZAOHOpyelgSQIrxyi3oO6ZCTHUgOXZAv8b2lMqqBCsrW875ncyJ1z9lbIqJlf6Y5EwwYahSBucB43yOCCdAZCOgX4cOYUsiEBykSZCtc1OZA9FkUquv7a2mNjXQC88ZBVLIs3KR4EgwS6NNQPWh4rulpgOVTngTHxRS9eRnJxx6wHM91srNwEmyN4ZBgYR5kr0FfxgZDZD';

  // Get first garage with messaging access
  const garage = await prisma.garage.findFirst({
    where: { hasMessagingAccess: true },
    select: { id: true, name: true },
  });

  if (!garage) {
    console.log('❌ No garage found with messaging access!');
    return;
  }

  console.log('🏢 Using garage:', garage.name);
  console.log('📘 Facebook Page:', pageName);
  console.log('🆔 Page ID:', pageId);
  console.log('');

  // Check if connection already exists
  const existing = await prisma.socialMediaConnection.findFirst({
    where: {
      garageId: garage.id,
      platform: 'facebook',
    },
  });

  if (existing) {
    console.log('⚠️  Connection already exists, updating...');
    const updated = await prisma.socialMediaConnection.update({
      where: { id: existing.id },
      data: {
        pageId,
        accessToken,
        isActive: true,
      },
    });
    console.log('✅ Connection updated!');
    console.log('   Connection ID:', updated.id);
  } else {
    console.log('Creating new connection...');
    const connection = await prisma.socialMediaConnection.create({
      data: {
        garageId: garage.id,
        platform: 'facebook',
        pageId,
        accessToken,
        isActive: true,
      },
    });
    console.log('✅ Connection created!');
    console.log('   Connection ID:', connection.id);
  }

  console.log('');
  console.log('🎉 Facebook Messenger is now connected!');
  console.log('');
  console.log('Next steps:');
  console.log('1. Configure webhook in Meta dashboard');
  console.log('2. Subscribe page to webhook');
  console.log('3. Send a test message to your Facebook Page');
  console.log('');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
