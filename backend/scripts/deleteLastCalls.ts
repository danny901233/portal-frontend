import { prisma } from '../src/db';

const garageId = process.argv[2];
const countArg = process.argv[3];
const count = countArg ? Number.parseInt(countArg, 10) : 5;

if (!garageId) {
  console.error('Usage: tsx backend/scripts/deleteLastCalls.ts <garageId> [count]');
  process.exit(1);
}

if (!Number.isFinite(count) || count <= 0) {
  console.error('Count must be a positive integer.');
  process.exit(1);
}

const run = async () => {
  const calls = await prisma.call.findMany({
    where: { garageId },
    orderBy: { createdAt: 'desc' },
    take: count,
    select: { id: true, createdAt: true, roomName: true },
  });

  if (calls.length === 0) {
    console.log(`No calls found for garage ${garageId}.`);
    return;
  }

  const callIds = calls.map((call) => call.id);
  console.log('Deleting calls:', calls);

  const result = await prisma.call.deleteMany({
    where: { id: { in: callIds } },
  });

  console.log(`Deleted ${result.count} call(s) for garage ${garageId}.`);
};

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
