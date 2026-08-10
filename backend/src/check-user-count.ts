import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkUserCount() {
  const users = await prisma.user.findMany({
    where: { role: 'USER' },
    select: { email: true }
  });

  console.log('Total users who will receive the feature announcement:', users.length);
  console.log('\nFirst 5 email addresses:');
  users.slice(0, 5).forEach(u => console.log('  -', u.email));
  if (users.length > 5) {
    console.log('  ... and', users.length - 5, 'more');
  }

  await prisma.$disconnect();
}

checkUserCount();
