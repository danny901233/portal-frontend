import { AsyncLocalStorage } from 'node:async_hooks';
import type { Request, Response, NextFunction } from 'express';

/**
 * Who is making the current request, available anywhere without threading it through every
 * function signature.
 *
 * The garage audit log needs to record who changed a price or switched off someone's access, and
 * that happens in half a dozen places across admin and billing routes. Instrumenting each call
 * site means missing one — and the one you miss is the change you most want explained later.
 * A Prisma hook catches every path, but Prisma has no idea who is signed in, so the identity has
 * to travel with the request. That is what this is for.
 */
export interface ActingUser {
  userId?: string;
  email?: string;
}

const storage = new AsyncLocalStorage<ActingUser>();

/**
 * Run the rest of the request inside a context that knows who is signed in.
 *
 * Called from the authenticate middleware rather than registered globally: req.user is populated
 * per route by authenticate, so a global app.use would capture nothing and every change would be
 * logged as "system" — which is exactly what happened the first time round.
 */
export function runWithActor(user: ActingUser | undefined, next: () => void): void {
  storage.run({ userId: user?.userId, email: user?.email }, next);
}

/** Express middleware for routes that authenticate themselves later. Harmless when unused. */
export function trackActingUser(req: Request, _res: Response, next: NextFunction): void {
  const user = (req as Request & { user?: ActingUser }).user;
  storage.run({ userId: user?.userId, email: user?.email }, () => next());
}

export function currentActor(): ActingUser | undefined {
  return storage.getStore();
}
