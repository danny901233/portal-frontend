// Is this user allowed to act on this garage's data?
//
// The tenancy model is `User.garageAccessIds`, with RECEPTIONMATE_STAFF widened to everything
// (login re-broadens staff to all garages, so their list is not authoritative).
//
// Resolved from the database rather than the JWT: a token issued before a garage was granted or
// revoked carries a stale list, and these checks decide whether one garage can read another's
// customer conversations.

import { prisma } from '../db.js';

export interface GarageAccessUser {
  role: string | null;
  garageAccessIds: string[];
}

/** The decision, separated from the lookup so it can be tested directly. */
export function hasGarageAccess(user: GarageAccessUser | null, garageId: string): boolean {
  if (!user) return false;
  if (user.role === 'RECEPTIONMATE_STAFF') return true;
  return (user.garageAccessIds ?? []).includes(garageId);
}

/** Look the user up and apply `hasGarageAccess`. False for an unknown user. */
export async function userCanAccessGarage(
  userId: string | undefined,
  garageId: string,
): Promise<boolean> {
  if (!userId) return false;

  // The onboarding API acts as itself rather than as a person, and is already staff-scoped by
  // the authenticate middleware.
  if (userId === 'api-onboarding') return true;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, garageAccessIds: true },
  });
  return hasGarageAccess(user, garageId);
}
