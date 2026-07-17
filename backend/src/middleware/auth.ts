import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import type { BranchRole } from '../utils/branchRoles.js';
import { prisma } from '../db.js';

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

export const authenticate = async (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'Authorization header missing' });
  }

  const token = authHeader.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ error: 'Token missing' });
  }

  let decoded: JwtPayload;
  try {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      throw new Error('JWT_SECRET is not configured');
    }
    decoded = jwt.verify(token, secret) as JwtPayload;
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  // The token proves WHO they are. It must not decide WHAT they can see: it lives for 7 days,
  // so a token minted before someone was given a branch hides it until they next log in, and a
  // token minted before their access was REVOKED keeps working for a week. Read the current
  // answer instead — one primary-key lookup. Same reasoning as requireManagerLive below.
  //
  // Staff are deliberately skipped: login expands their garageIds to every garage on the estate,
  // which is not what their own garageAccessIds holds, and the API-key user has no DB row at all.
  if (decoded.role !== 'RECEPTIONMATE_STAFF') {
    try {
      const dbUser = await prisma.user.findUnique({
        where: { id: decoded.userId },
        select: { role: true, garageAccessIds: true, branchRoles: true },
      });
      if (!dbUser) {
        // Deleted since the token was issued.
        return res.status(401).json({ error: 'Invalid token' });
      }
      decoded.role = dbUser.role as JwtPayload['role'];
      decoded.garageIds = Array.isArray(dbUser.garageAccessIds) ? dbUser.garageAccessIds : [];
      decoded.branchRoles = (dbUser.branchRoles as Record<string, BranchRole> | null) ?? {};
    } catch (err) {
      // Fail closed: a database blip must not silently fall back to a stale token's permissions.
      console.error('[AUTH] could not refresh access from the database:', err);
      return res.status(500).json({ error: 'Authorization check failed' });
    }
  }

  req.user = decoded;
  next();
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
