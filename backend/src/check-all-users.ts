import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkAllUsers() {
  const users = await prisma.user.findMany({
    select: { email: true, role: true }
  });

  console.log('Total users in database:', users.length);
  console.log('\nAll users:');
  users.forEach(u => console.log(`  - ${u.email} (${u.role})`));

  await prisma.$disconnect();
}

checkAllUsers();
