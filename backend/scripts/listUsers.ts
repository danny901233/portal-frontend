import { prisma } from '../src/db.js';

async function main() {
  const users = await prisma.user.findMany({
    select: {
      id: true,
      email: true,
      role: true,
      garageAccessIds: true,
      branchRoles: true,
    },
  });
  console.log(JSON.stringify(users, null, 2));
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
