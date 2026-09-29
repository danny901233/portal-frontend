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

import twilio from 'twilio';

import { prisma } from '../db.js';

// Releasing a number is the only outward-facing thing archiving does, so it gets its own client
// rather than borrowing one from a notification service that may be unconfigured.
const twilioClient = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

/**
 * Give a leaver's number back to Twilio.
 *
 * Clearing `twilioNumber` in Postgres only makes it invisible to us — Twilio keeps charging
 * monthly rental for a number nobody answers. Delisle, Holmer Green and TWA were all released by
 * hand after the fact, which is exactly the step that gets forgotten.
 *
 * Returns false and logs rather than throwing: a Twilio outage must not stop a garage being
 * archived, because the archive is what actually stops us answering their calls.
 */
async function releaseTwilioNumber(number: string, garageName: string): Promise<boolean> {
  if (!twilioClient) {
    console.warn(`[AUTO_ARCHIVE] ${garageName}: Twilio not configured, ${number} NOT released`);
    return false;
  }
  try {
    // The number is stored in assorted shapes ("441772211508", "+44 333 370 1610"), so match on
    // digits rather than trusting the stored formatting.
    const digits = number.replace(/\D/g, '');
    const owned = await twilioClient.incomingPhoneNumbers.list({ limit: 1000 });
    const match = owned.find((n) => (n.phoneNumber || '').replace(/\D/g, '') === digits);
    if (!match) {
      console.log(`[AUTO_ARCHIVE] ${garageName}: ${number} is not on the account — nothing to release`);
      return true;
    }
    await twilioClient.incomingPhoneNumbers(match.sid).remove();
    console.log(`[AUTO_ARCHIVE] ${garageName}: released ${number} (${match.sid})`);
    return true;
  } catch (error) {
    console.error(`[AUTO_ARCHIVE] ${garageName}: FAILED to release ${number} — still being billed`, error);
    return false;
  }
}

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


/**
 * Archive garages whose notice period has expired.
 *
 * A leaver keeps full service until the day their notice runs out, then this switches them off:
 * voice and messaging access removed, pricing zeroed, archivedAt stamped. The voice route refuses
 * archived garages, so calls stop being answered the same morning — without anyone remembering.
 */
export async function archiveDueGarages(): Promise<number> {
  const due = await prisma.garage.findMany({
    where: { archiveScheduledAt: { lte: new Date() }, archivedAt: null },
    select: { id: true, name: true, archiveScheduledAt: true, twilioNumber: true },
  });
  for (const g of due) {
    const archivedAt = new Date();

    // Hand the number back before clearing it, or we lose the only record of what to release.
    let released = true;
    if (g.twilioNumber && g.twilioNumber.trim()) {
      released = await releaseTwilioNumber(g.twilioNumber.trim(), g.name);
    }

    await prisma.garage.update({
      where: { id: g.id },
      data: {
        archivedAt,
        hasVoiceAccess: false,
        hasMessagingAccess: false,
        subscriptionCostGbp: 0,
        messagingSubscriptionCostGbp: 0,
        // Only forget the number once Twilio has actually taken it back. Clearing it after a
        // failed release would leave a number nobody can trace and we keep paying for.
        ...(released ? { twilioNumber: null } : {}),
      },
    });

    // Stop the daily billing job selecting them once they are gone.
    const users = await prisma.user.findMany({
      where: { garageAccessIds: { has: g.id } },
      select: { id: true, email: true, garageAccessIds: true, lockedAt: true },
    });
    for (const u of users) {
      await prisma.user.update({ where: { id: u.id }, data: { nextBillingDate: null } });

      // Lock the account once NOTHING they can reach is still live. A user on a multi-branch
      // business keeps their login while any branch remains — only the last branch leaving ends
      // their access. Previously nobody was ever locked, so Boam, Stourbridge and Cairneys could
      // all still sign in weeks after their garage was archived.
      if (u.lockedAt) continue;
      const stillLive = await prisma.garage.count({
        where: { id: { in: u.garageAccessIds as string[] }, archivedAt: null },
      });
      if (stillLive > 0) continue;

      await prisma.user.update({
        where: { id: u.id },
        data: {
          lockedAt: archivedAt,
          lockedReason: `Garage archived ${archivedAt.toISOString().slice(0, 10)} — no active branches remain.`,
          // Kill any session already signed in, otherwise the lock only bites at next login.
          sessionsValidFrom: archivedAt,
        },
      });
      console.log(`[AUTO_ARCHIVE] locked ${u.email} — no active branches remain`);
    }

    console.log(`[AUTO_ARCHIVE] ${g.name} — notice expired ${g.archiveScheduledAt?.toISOString().slice(0, 10)}, service off`);
  }
  if (due.length) console.log(`[AUTO_ARCHIVE] archived ${due.length} garage(s)`);
  return due.length;
}
