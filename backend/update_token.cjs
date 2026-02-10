require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const garageId = '827efd7f-c5df-47b1-b2b0-f9a5bde39efa';
  const newToken = 'EAAWvZApHZBPUwBQjJTmTJ25OYfKab5xQMI1Bt6EntSYPtRqBET2HG5CB0KHONmmrbyOgAClLVi9shkGhKn0BcRZCiAyVasbfhpTZA4IShK3pZAJDJiUJDbfhMy2MsX40rIycYpqa3I1WzKOuT5TjyqTy0DBAESZACuw65pTqpbvwtZB0m7pjDJ5NsuVg6jNkMZBkfW9p';

  const updated = await prisma.socialMediaConnection.updateMany({
    where: {
      garageId,
      platform: 'facebook',
    },
    data: {
      accessToken: newToken,
    }
  });

  console.log('✅ Access token updated!');
  console.log(`   Updated ${updated.count} connection(s)`);
  console.log('');
  console.log('🎉 Ready to test messaging!');
}

main()
  .catch(err => console.error('❌ Error:', err.message))
  .finally(() => prisma.$disconnect());
