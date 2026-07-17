import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';

const router = Router();

// This endpoint has been disabled.
// It previously contained hardcoded credentials and no authentication.
// Facebook connections should be managed via the OAuth flow in /api/oauth/meta/initiate.
router.post('/admin/create-fb-connection', authenticate, (_req, res) => {
  res.status(410).json({
    error: 'This endpoint has been disabled. Use the OAuth integration flow instead.',
  });
});

export default router;
