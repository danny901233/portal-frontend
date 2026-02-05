#!/usr/bin/env tsx
/**
 * Cleanup script to delete all calls under 30 seconds
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function cleanupShortCalls() {
  try {
    console.log('🔍 Finding calls under 30 seconds...\n');

    // Delete all calls with duration under 30 seconds
    // This includes both durationSeconds and recordingDurationSeconds
    const deletedCalls = await prisma.call.deleteMany({
      where: {
        OR: [
          { durationSeconds: { lt: 30 } },
          { recordingDurationSeconds: { lt: 30 } },
        ],
      },
    });

    console.log(`🗑️  Deleted ${deletedCalls.count} calls with duration < 30 seconds`);
    console.log('');
    console.log('✅ Cleanup complete!');

  } catch (error) {
    console.error('❌ Error cleaning up short calls:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

cleanupShortCalls()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Cleanup failed:', error);
    process.exit(1);
  });
