import { prisma } from '../src/db.js';

async function main() {
  const garages = await prisma.garage.findMany({
    select: {
      id: true,
      name: true,
    },
    orderBy: {
      name: 'asc',
    },
  });

  console.log(JSON.stringify(garages, null, 2));
}

main()
  .catch((error) => {
    console.error('Failed to list garages:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
