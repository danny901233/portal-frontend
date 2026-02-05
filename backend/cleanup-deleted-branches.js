// Cleanup script to remove deleted branches from user accounts
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function cleanupDeletedBranches() {
  console.log('Starting cleanup of deleted branches from user accounts...');

  // Get all existing garage IDs
  const garages = await prisma.garage.findMany({
    select: { id: true },
  });
  const existingGarageIds = new Set(garages.map((g) => g.id));
  console.log(`Found ${existingGarageIds.size} existing garages in database`);

  // Get all users
  const users = await prisma.user.findMany();
  console.log(`Found ${users.length} users to check`);

  let totalCleaned = 0;

  for (const user of users) {
    const garageAccessIds = Array.isArray(user.garageAccessIds) ? user.garageAccessIds : [];
    const branchRoles = typeof user.branchRoles === 'object' && user.branchRoles !== null && !Array.isArray(user.branchRoles)
      ? user.branchRoles
      : {};

    // Filter out non-existent garage IDs from garageAccessIds
    const validGarageIds = garageAccessIds.filter((id) => existingGarageIds.has(id));
    const removedFromAccessIds = garageAccessIds.length - validGarageIds.length;

    // Filter out non-existent garage IDs from branchRoles
    const validBranchRoles = {};
    let removedFromBranchRoles = 0;
    for (const [garageId, role] of Object.entries(branchRoles)) {
      if (existingGarageIds.has(garageId)) {
        validBranchRoles[garageId] = role;
      } else {
        removedFromBranchRoles++;
      }
    }

    // Update user if any cleanup is needed
    if (removedFromAccessIds > 0 || removedFromBranchRoles > 0) {
      console.log(`User ${user.email}:`);
      console.log(`  - Removed ${removedFromAccessIds} deleted branches from garageAccessIds`);
      console.log(`  - Removed ${removedFromBranchRoles} deleted branches from branchRoles`);

      await prisma.user.update({
        where: { id: user.id },
        data: {
          garageAccessIds: validGarageIds,
          branchRoles: validBranchRoles,
        },
      });

      totalCleaned += removedFromAccessIds + removedFromBranchRoles;
    }
  }

  console.log(`\nCleanup complete! Removed ${totalCleaned} deleted branch references from user accounts.`);
  await prisma.$disconnect();
}

cleanupDeletedBranches().catch((error) => {
  console.error('Cleanup failed:', error);
  process.exit(1);
});
