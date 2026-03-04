require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const newGarageId = 'd51dfa55-15d0-4d60-ad81-c675579d16f6'; // ReceptionMate Branch - where messages are going
  const newToken = 'EAAWvZApHZBPUwBQjJTmTJ25OYfKab5xQMI1Bt6EntSYPtRqBET2HG5CB0KHONmmrbyOgAClLVi9shkGhKn0BcRZCiAyVasbfhpTZA4IShK3pZAJDJiUJDbfhMy2MsX40rIycYpqa3I1WzKOuT5TjyqTy0DBAESZACuw65pTqpbvwtZB0m7pjDJ5NsuVg6jNkMZBkfW9p';
  const pageId = '224576834077659';

  console.log('Moving Facebook connection to correct garage...');
  console.log('Target: ReceptionMate Branch (' + newGarageId + ')');

  // Delete all Facebook connections
  const deleted = await prisma.socialMediaConnection.deleteMany({
    where: { platform: 'facebook' },
  });
  console.log(`Deleted ${deleted.count} old connection(s)`);

  // Create in correct garage
  const connection = await prisma.socialMediaConnection.create({
    data: {
      garageId: newGarageId,
      platform: 'facebook',
      pageId,
      accessToken: newToken,
      isActive: true,
    },
  });

  console.log('✅ Connection created!');
  console.log('   ID:', connection.id);
  console.log('   Garage: ReceptionMate Branch');
  console.log('   Page ID:', pageId);
  console.log('');
  console.log('🎉 Facebook now connected to the correct garage!');
}

main()
  .catch(err => console.error('❌ Error:', err.message))
  .finally(() => prisma.$disconnect());
