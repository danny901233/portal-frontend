// Automatic reset of recurring ops-board tasks.
//
// A daily task ticked off on Monday must be open again on Tuesday, a weekly one on Monday
// morning, a monthly one on the 1st. Until now only 'daily' could be reset, and only by someone
// remembering to press a button.
//
// What a reset does NOT touch: the assignee. A task that belongs to Gab still belongs to Gab next
// period — resetting ownership every night would mean re-assigning 30 tasks every morning. Notes
// are also kept: on a recurring task last period's note ("waiting on Dan for the API key") is
// usually still the relevant context, and the completion log has already snapshotted the note as
// it stood when the task was ticked.
//
// Ordering matters: the daily report runs at 21:00 and the daily reset just after midnight, so a
// day is always reported before it is wiped. Completions live in OpsTaskCompletion regardless, so
// history survives the reset either way.

import { prisma } from '../db.js';

export type ResettableCadence = 'daily' | 'weekly' | 'monthly';

/**
 * Flip every completed task of this cadence back to open.
 * Tasks already open are left alone — they were never done, and there is nothing to reset.
 */
export async function resetRecurringTasks(cadence: ResettableCadence): Promise<number> {
  const result = await prisma.opsTask.updateMany({
    where: { cadence, status: 'done' },
    data: { status: 'open', completedAt: null, completedById: null },
  });

  // Anything still open at reset time was missed for the period. Worth saying out loud in the
  // logs — the report shows it too, but this makes a repeatedly-skipped task easy to spot.
  const stillOpen = await prisma.opsTask.count({ where: { cadence, status: 'open' } });
  const missed = stillOpen - result.count;

  console.log(
    `[OPS_RESET] ${cadence}: reset ${result.count} completed task(s) back to open`
    + (missed > 0 ? `; ${missed} were never completed this period` : ''),
  );
  return result.count;
}
