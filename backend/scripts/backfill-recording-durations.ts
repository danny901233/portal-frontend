#!/usr/bin/env tsx
/**
 * Backfill recording durations from TwilioRecording to Call table
 *
 * This script updates calls that have recording data in TwilioRecording
 * but don't have recordingDurationSeconds set in the Call table.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function backfillRecordingDurations() {
  try {
    console.log('🔍 Finding calls with missing recording durations...\n');

    // Find all TwilioRecordings with valid data
    const recordings = await prisma.twilioRecording.findMany({
      where: {
        recordingDurationSeconds: { not: null },
      },
      select: {
        callSid: true,
        recordingSid: true,
        recordingDurationSeconds: true,
        recordingUrl: true,
        completedAt: true,
      },
    });

    console.log(`📊 Found ${recordings.length} recordings in TwilioRecording table\n`);

    let updatedCount = 0;
    let deletedCount = 0;
    let skippedCount = 0;

    for (const recording of recordings) {
      const { callSid, recordingSid, recordingDurationSeconds, recordingUrl, completedAt } = recording;

      if (!recordingDurationSeconds) continue;

      // Find calls with this twilioCallSid that don't have recording duration
      const calls = await prisma.call.findMany({
        where: {
          twilioCallSid: callSid,
          recordingDurationSeconds: null,
        },
        select: {
          id: true,
          durationSeconds: true,
          recordingDurationSeconds: true,
        },
      });

      if (calls.length === 0) {
        skippedCount++;
        continue;
      }

      for (const call of calls) {
        // If recording duration is under 30 seconds, delete the call
        if (recordingDurationSeconds < 30) {
          console.log(`🗑️  Deleting Call ${call.id}:`);
          console.log(`   CallSid: ${callSid}`);
          console.log(`   Old duration: ${call.durationSeconds}s`);
          console.log(`   Recording duration: ${recordingDurationSeconds}s (under 30s threshold)`);

          await prisma.call.delete({
            where: { id: call.id },
          });

          deletedCount++;
          console.log(`   ✅ Deleted!\n`);
        } else {
          // Duration >= 30 seconds, update the call
          console.log(`📝 Updating Call ${call.id}:`);
          console.log(`   CallSid: ${callSid}`);
          console.log(`   Old duration: ${call.durationSeconds}s`);
          console.log(`   New duration: ${recordingDurationSeconds}s`);
          console.log(`   RecordingSid: ${recordingSid}`);

          await prisma.call.update({
            where: { id: call.id },
            data: {
              durationSeconds: recordingDurationSeconds,
              recordingDurationSeconds: recordingDurationSeconds,
              recordingUrl: recordingSid,
              recordingCompletedAt: completedAt,
            },
          });

          updatedCount++;
          console.log(`   ✅ Updated!\n`);
        }
      }
    }

    console.log('📊 Summary:');
    console.log(`   ✅ Updated: ${updatedCount} calls (duration >= 30s)`);
    console.log(`   🗑️  Deleted: ${deletedCount} calls (duration < 30s)`);
    console.log(`   ⏭️  Skipped: ${skippedCount} calls (already have recording duration)`);
    console.log(`   📝 Total recordings: ${recordings.length}`);

  } catch (error) {
    console.error('❌ Error backfilling recording durations:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Run the script
backfillRecordingDurations()
  .then(() => {
    console.log('\n✅ Backfill complete!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Backfill failed:', error);
    process.exit(1);
  });
