import { resolveAllowedGarages } from './auth.js';

/**
 * May this user open this call, wherever the branch picker happens to be set?
 *
 * The call detail page used to ask for `/api/garages/<selected branch>/calls/<id>`, which 404s
 * for a call belonging to a sibling branch — so a link from the observability fault list, an
 * email or a bookmark only worked if you were already switched to the right branch.
 *
 * Resolving the garage from the CALL fixes that, and makes this check the only thing standing
 * between a user and someone else's call. So the decision stays where it already was: the
 * user's own garage list, never anything carried on the request.
 */
export function mayOpenCall(
  user: { role?: string; garageIds?: string[]; garageId?: string } | undefined,
  callGarageId: string | null | undefined,
): boolean {
  if (!user) return false;
  if (user.role === 'RECEPTIONMATE_STAFF') return true;
  // A call with no garage on it cannot be matched against anyone's access, so it is refused
  // rather than waved through — absence of a garage is not permission.
  if (!callGarageId) return false;
  return resolveAllowedGarages(user).includes(callGarageId);
}
