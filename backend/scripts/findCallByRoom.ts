import { prisma } from '../src/db.js';

const roomName = process.argv[2];

if (!roomName) {
  console.error('Usage: npx tsx scripts/findCallByRoom.ts <room-name>');
  process.exit(1);
}

const main = async () => {
  const call = await prisma.call.findFirst({ where: { roomName } });
  console.log(JSON.stringify(call, null, 2));
};

main()
  .catch((error) => {
    console.error('Failed to find call:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
