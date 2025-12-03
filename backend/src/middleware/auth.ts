import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import type { BranchRole } from '../utils/branchRoles.js';

interface JwtPayload {
  userId: string;
  email: string;
  garageIds?: string[];
  garageId?: string;
  role?: 'ADMIN' | 'USER' | 'RECEPTIONMATE_STAFF';
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

export const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
  if (!req.user || req.user.role !== 'RECEPTIONMATE_STAFF') {
    return res.status(403).json({ error: 'ReceptionMate staff access required' });
  }
  next();
};
