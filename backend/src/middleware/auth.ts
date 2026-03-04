import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import type { BranchRole } from '../utils/branchRoles.js';

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
    const decoded = jwt.verify(token, secret) as JwtPayload;
    req.user = decoded;
    next();
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
