import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import type { BranchRole } from '../utils/branchRoles.js';
import { prisma } from '../db.js';
import { runWithActor } from '../utils/actingUser.js';

interface JwtPayload {
  userId: string;
  email: string;
  garageIds?: string[];
  garageId?: string;
  role?: 'MANAGER' | 'USER' | 'RECEPTIONMATE_STAFF';
  branchRoles?: Record<string, BranchRole>;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: JwtPayload;
  }
}

/**
 * Cache of each user's sessionsValidFrom, so revocation does not cost a database round trip on
 * every authenticated request. Bumping sessionsValidFrom is the only way to sign somebody out
 * when tokens are stateless, and it has to be checked on every request for that to mean anything.
 *
 * A 60-second TTL means a forced logout takes effect within a minute rather than instantly. That
 * is the trade for not querying the User table on every call; if we ever need it immediate, clear
 * the entry at the point of revocation rather than shortening this for everyone.
 */
const revocationCache = new Map<string, { validFrom: number | null; cachedAt: number }>();
const REVOCATION_TTL_MS = 60_000;

export function forgetRevocation(userId: string): void {
  revocationCache.delete(userId);
}

async function tokenPredatesRevocation(userId: string, issuedAtSeconds?: number): Promise<boolean> {
  // No iat means a token we cannot date, so we cannot say it is stale. Tokens are signed by us
  // and always carry one; this is belt and braces rather than a real case.
  if (!issuedAtSeconds) return false;
  const cached = revocationCache.get(userId);
  let validFrom: number | null;
  if (cached && Date.now() - cached.cachedAt < REVOCATION_TTL_MS) {
    validFrom = cached.validFrom;
  } else {
    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { sessionsValidFrom: true },
      });
      validFrom = user?.sessionsValidFrom ? user.sessionsValidFrom.getTime() : null;
      revocationCache.set(userId, { validFrom, cachedAt: Date.now() });
    } catch (err) {
      // If the lookup fails, let the request through. A database blip should not sign everybody
      // out of the portal.
      console.error('[AUTH] revocation check failed:', err);
      return false;
    }
  }
  if (validFrom === null) return false;
  // iat is whole seconds, so compare at second resolution to avoid a token issued in the same
  // second as the revocation being wrongly kept alive.
  return issuedAtSeconds * 1000 < validFrom;
}

export const authenticate = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'Authorization header missing' });
  }

  const token = authHeader.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ error: 'Token missing' });
  }

  try {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      throw new Error('JWT_SECRET is not configured');
    }
    const decoded = jwt.verify(token, secret) as JwtPayload & { iat?: number };
    // Signed out since this token was issued? Then it is no longer valid, however fresh it looks.
    tokenPredatesRevocation(decoded.userId, decoded.iat)
      .then((revoked) => {
        if (revoked) {
          return res.status(401).json({ error: 'Session ended — please sign in again' });
        }
        req.user = decoded;
        // Everything downstream now runs knowing who this is, so the garage audit hook can
        // attribute a change to a person rather than to "system".
        runWithActor(decoded, next);
      })
      .catch(() => {
        req.user = decoded;
        runWithActor(decoded, next);
      });
    return;
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

export const authenticateApiKey = (req: Request, res: Response, next: NextFunction) => {
  const apiKey = req.headers['x-api-key'];
  const validApiKey = process.env.ONBOARDING_API_KEY;

  if (!validApiKey) {
    return res.status(500).json({ error: 'API key authentication not configured' });
  }

  if (apiKey === validApiKey) {
    // Set a synthetic admin user for API key requests
    req.user = {
      userId: 'api-onboarding',
      email: 'api@receptionmate.com',
      role: 'RECEPTIONMATE_STAFF',
    };
    return next();
  }

  // Fall back to JWT authentication
  return authenticate(req, res, next);
};

export const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
  if (!req.user || req.user.role !== 'RECEPTIONMATE_STAFF') {
    return res.status(403).json({ error: 'ReceptionMate staff access required' });
  }
  next();
};

// Requires MANAGER or RECEPTIONMATE_STAFF — blocks plain USER role
// Also accepts users who have MANAGER in their branchRoles for the requested garage
export const requireManager = (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  // Staff always allowed
  if (req.user.role === 'RECEPTIONMATE_STAFF') {
    return next();
  }
  // Top-level MANAGER allowed
  if (req.user.role === 'MANAGER') {
    return next();
  }
  // Check branchRoles for the specific garage being accessed (from route params)
  const garageId = req.params.garageId;
  if (garageId && req.user.branchRoles && req.user.branchRoles[garageId] === 'MANAGER') {
    return next();
  }
  return res.status(403).json({ error: 'Manager access required' });
};

// Same rule as requireManager, but re-reads the user's CURRENT role + branchRoles
// from the DB instead of trusting the JWT (which is stateless and lives up to 7
// days). Use on sensitive routes where a revoked access must take effect
// immediately — e.g. demoting a branch MANAGER should lock them out on their very
// next request, not whenever their old token happens to expire.
export const requireManagerLive = async (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  // Staff token (incl. the synthetic API-key user, which has no DB row) — trust it.
  if (req.user.role === 'RECEPTIONMATE_STAFF') {
    return next();
  }
  try {
    const dbUser = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { role: true, branchRoles: true },
    });
    if (!dbUser) {
      return res.status(403).json({ error: 'Manager access required' });
    }
    if (dbUser.role === 'RECEPTIONMATE_STAFF' || dbUser.role === 'MANAGER') {
      return next();
    }
    const garageId = req.params.garageId;
    const branchRoles = (dbUser.branchRoles as Record<string, BranchRole> | null) || {};
    if (garageId && branchRoles[garageId] === 'MANAGER') {
      return next();
    }
    return res.status(403).json({ error: 'Manager access required' });
  } catch (err) {
    return res.status(500).json({ error: 'Authorization check failed' });
  }
};
