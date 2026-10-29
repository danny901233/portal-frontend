/**
 * May this user act on this garage?
 *
 * STAFF ARE NOT IN THEIR OWN ALLOW-LIST. Login widens RECEPTIONMATE_STAFF to every unarchived
 * garage and bakes that list into a 7-day JWT, so a garage onboarded after someone signed in is
 * simply absent from their token. `resolveAllowedGarages(...).includes(...)` on its own therefore
 * refuses staff access to the newest garages — which is exactly what happened on 29 Oct 2026:
 * /garages/<id>/agent-config returned 403 for Woodyard Garage Redditch, created two days after
 * the token was minted, while every other endpoint on the same garage answered fine.
 *
 * The role check has to come FIRST, before the list is consulted, because for staff the list is
 * a stale snapshot rather than a statement of permission. conversations.ts and
 * social-connections.ts each worked this out and wrote their own private copy; this is that same
 * decision in one place. utils/garageAccess.ts resolves the same question from the DATABASE
 * instead, which additionally handles revocation — prefer it where a request can afford the
 * lookup and the stakes are another tenant's data.
 */
export const mayAccessGarage = (
  payload: { role?: string; garageIds?: string[]; garageId?: string } | undefined,
  garageId: string | null | undefined,
): boolean => {
  if (!payload) return false;
  if (payload.role === 'RECEPTIONMATE_STAFF') return true;
  // No garage on the request cannot be matched against anyone's access, so it is refused rather
  // than waved through: absence of a garage is not permission.
  if (!garageId) return false;
  return resolveAllowedGarages(payload).includes(garageId);
};

export const resolveAllowedGarages = (
  payload?: { garageIds?: string[]; garageId?: string }
): string[] => {
  if (!payload) {
    return [];
  }
  const { garageIds, garageId } = payload;
  if (Array.isArray(garageIds) && garageIds.length > 0) {
    return garageIds;
  }
  if (typeof garageId === 'string' && garageId.trim()) {
    return [garageId.trim()];
  }
  return [];
};
