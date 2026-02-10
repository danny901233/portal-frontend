require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const garageId = '827efd7f-c5df-47b1-b2b0-f9a5bde39efa'; // ReceptionMate Garage
  const pageId = '224576834077659';
  const accessToken = 'EAAWvZApHZBPUwBQp22ZCQOsSZBKJohLHeILJDZAYOCsjUZAOHOpyelgSQIrxyi3oO6ZCTHUgOXZAv8b2lMqqBCsrW875ncyJ1z9lbIqJlf6Y5EwwYahSBucB43yOCCdAZCOgX4cOYUsiEBykSZCtc1OZA9FkUquv7a2mNjXQC88ZBVLIs3KR4EgwS6NNQPWh4rulpgOVTngTHxRS9eRnJxx6wHM91srNwEmyN4ZBgYR5kr0FfxgZDZD';

  console.log('🔄 Connecting to production database...');
  console.log('   Garage: ReceptionMate Garage');
  console.log('   Page: ReceptionMate (224576834077659)');
  console.log('');

  // Delete existing connection
  const deleted = await prisma.socialMediaConnection.deleteMany({
    where: { garageId, platform: 'facebook' }
  });
  if (deleted.count > 0) {
    console.log(`🗑️  Deleted ${deleted.count} existing connection(s)`);
  }

  // Create new connection
  const connection = await prisma.socialMediaConnection.create({
    data: {
      garageId,
      platform: 'facebook',
      pageId,
      accessToken,
      isActive: true,
    }
  });

  console.log('✅ Facebook connection added to production!');
  console.log('   Connection ID:', connection.id);
  console.log('');
  console.log('🎉 Now ready to receive Facebook messages!');
  console.log('');
  console.log('📋 Next steps:');
  console.log('1. Go to https://developers.facebook.com/apps/1600229954436428/messenger/settings/');
  console.log('2. Subscribe your "ReceptionMate" page to webhook');
  console.log('3. Send a test message to your Facebook page');
  console.log('4. Check https://portal.receptionmate.co.uk/messages');
}

main()
  .catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
