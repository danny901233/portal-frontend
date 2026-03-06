import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkCustomerUsers() {
  const users = await prisma.user.findMany({
    where: { 
      role: {
        in: ['USER', 'MANAGER']
      }
    },
    select: { email: true, role: true }
  });

  console.log('Total customer users who will receive the feature announcement:', users.length);
  console.log('\nUsers:');
  users.forEach(u => console.log(`  - ${u.email} (${u.role})`));

  if (users.length === 0) {
    console.log('\n⚠️  No customer users found in database.');
    console.log('The email will only be sent when there are users with role USER or MANAGER.');
  }

  await prisma.$disconnect();
}

checkCustomerUsers();
