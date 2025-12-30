import { prisma } from '../src/db.js';

const garageId = process.argv[2];

if (!garageId) {
  console.error('Usage: npx tsx scripts/listRecentCalls.ts <garage-id> [limit]');
  process.exit(1);
}

const limitArg = process.argv[3];
const limit = limitArg ? Number.parseInt(limitArg, 10) : 10;

if (Number.isNaN(limit) || limit <= 0) {
  console.error('Limit must be a positive integer.');
  process.exit(1);
}

const main = async () => {
  const calls = await prisma.call.findMany({
    where: { garageId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  console.log(JSON.stringify(calls, null, 2));
};

main()
  .catch((error) => {
    console.error('Failed to list calls:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
