// Shared arrears / account-lockout timing.
//
// When a Stripe card charge fails we stamp Garage.paymentFailedAt. The garage keeps
// full access during a short grace period; once paymentFailedAt is older than the
// grace window the garage is "locked" — accessRestricted flips true, which withholds
// call content, swaps per-call emails for the arrears notice, and (in the portal)
// shows a full-screen payment blocker. A successful payment clears both fields.
//
// The lock is TIME-DERIVED so it needs no cron: any code path (webhook, backstop
// sweep, or the arrears-status endpoint) can compute it from paymentFailedAt.

import { prisma } from '../db.js';

export const ARREARS_GRACE_DAYS = 2;
export const ARREARS_GRACE_MS = ARREARS_GRACE_DAYS * 24 * 60 * 60 * 1000;

/** True once a failed payment has been outstanding longer than the grace window. */
export function isPastArrearsGrace(
  paymentFailedAt: Date | string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!paymentFailedAt) return false;
  return now.getTime() - new Date(paymentFailedAt).getTime() >= ARREARS_GRACE_MS;
}

/**
 * Effective lock for a garage. A garage is locked if it's been manually flagged
 * (accessRestricted) OR its failed payment is past the grace window. Used so the
 * portal blocker engages the moment the timer elapses, even before the backstop
 * sweep has flipped the persisted flag.
 */
export function isGarageLocked(
  garage: { accessRestricted?: boolean | null; paymentFailedAt?: Date | string | null },
  now: Date = new Date(),
): boolean {
  return Boolean(garage.accessRestricted) || isPastArrearsGrace(garage.paymentFailedAt, now);
}

let arrearsSweepTimer: NodeJS.Timeout | null = null;

/**
 * Flip accessRestricted → true for any garage whose failed payment is now past the grace
 * window. Backstop so the call-content withholding + arrears emails engage even for garages
 * that never open the portal. Cheap: only matches unlocked, past-grace rows.
 */
export async function sweepArrearsLocks(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - ARREARS_GRACE_MS);
    const res = await prisma.garage.updateMany({
      where: { accessRestricted: false, paymentFailedAt: { not: null, lte: cutoff } },
      data: { accessRestricted: true },
    });
    if (res.count > 0) {
      console.log(`[ARREARS] auto-locked ${res.count} garage(s) past the ${ARREARS_GRACE_DAYS}-day grace`);
    }
  } catch (e) {
    console.error('[ARREARS] sweep failed:', e);
  }
}

/** Start the periodic arrears sweep (runs once immediately, then on an interval). */
export function startArrearsSweep(intervalMs = 30 * 60 * 1000): void {
  if (arrearsSweepTimer) return;
  void sweepArrearsLocks();
  arrearsSweepTimer = setInterval(() => void sweepArrearsLocks(), intervalMs);
}
