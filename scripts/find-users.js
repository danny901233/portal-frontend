const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function findUsers() {
  try {
    const users = await prisma.user.findMany({
      where: {
        OR: [
          { email: { contains: 'dan', mode: 'insensitive' } },
          { email: { contains: 'receptionmate', mode: 'insensitive' } },
        ]
      },
    });

    console.log(`\nFound ${users.length} users:\n`);
    users.forEach(user => {
      console.log(`Email: ${user.email}`);
      console.log(`Role: ${user.role}`);
      console.log(`ID: ${user.id}`);
      console.log('---');
    });
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

findUsers();
