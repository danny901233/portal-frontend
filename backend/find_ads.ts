import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Search for anything with "ads" or "automotive"
  const garages = await prisma.garage.findMany({
    where: {
      OR: [
        { name: { contains: 'ADS', mode: 'insensitive' } },
        { name: { contains: 'Automotive', mode: 'insensitive' } }
      ]
    }
  });

  console.log('Garages found:', JSON.stringify(garages, null, 2));

  const users = await prisma.user.findMany({
    where: {
      email: { contains: 'ads', mode: 'insensitive' }
    }
  });

  console.log('\nUsers found:', JSON.stringify(users, null, 2));
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
