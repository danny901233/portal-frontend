const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const garageId = 'd51dfa35-15eb-ad6d-e081-c07557d1cf6';

  console.log(`Enabling messaging access for garage: ${garageId}`);

  const garage = await prisma.garage.update({
    where: { id: garageId },
    data: { hasMessagingAccess: true },
    select: { id: true, name: true, hasMessagingAccess: true },
  });

  console.log('Updated garage:', garage);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
