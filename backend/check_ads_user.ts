import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const user = await prisma.user.findUnique({
    where: { email: 'dave@ads-automotive.co.uk' }
  });

  console.log('User:', JSON.stringify(user, null, 2));

  const garage = await prisma.garage.findUnique({
    where: { id: '5cc2782c-233b-4aff-95e3-340084c0b62c' }
  });

  console.log('\nGarage:', JSON.stringify(garage, null, 2));
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
