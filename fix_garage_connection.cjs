require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const pageId = '224576834077659';
  const accessToken = 'EAAWvZApHZBPUwBQjJTmTJ25OYfKab5xQMI1Bt6EntSYPtRqBET2HG5CB0KHONmmrbyOgAClLVi9shkGhKn0BcRZCiAyVasbfhpTZA4IShK3pZAJDJiUJDbfhMy2MsX40rIycYpqa3I1WzKOuT5TjyqTy0DBAESZACuw65pTqpbvwtZB0m7pjDJ5NsuVg6jNkMZBkfW9p';

  console.log('Which garage should the Facebook page be connected to?');
  console.log('1. d51dfa55-15d0-4d60-ad81-c675579d16f6 (ReceptionMate Branch - messages going here)');
  console.log('2. 827efd7f-c5df-47b1-b2b0-f9a5bde39efa (ReceptionMate Garage - connection is here)');
  console.log('\nMoving connection to garage 1 (where messages are going)...');

  const targetGarageId = 'd51dfa55-15d0-4d60-ad81-c675579d16f6';

  // Delete old connections
  await prisma.socialMediaConnection.deleteMany({
    where: { platform: 'facebook' }
  });

  // Create in correct garage
  const connection = await prisma.socialMediaConnection.create({
    data: {
      garageId: targetGarageId,
      platform: 'facebook',
      pageId,
      accessToken,
      isActive: true,
    }
  });

  console.log('✅ Facebook connection moved to correct garage!');
  console.log('   Garage:', targetGarageId);
  console.log('   Connection ID:', connection.id);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
