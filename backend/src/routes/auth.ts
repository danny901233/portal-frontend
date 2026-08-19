import type { Request, Response } from 'express';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { prisma } from '../db.js';
import { loginSchema } from '../utils/validators.js';
import { sanitizeBranchRoles } from '../utils/branchRoles.js';
import { sendEmail } from '../utils/email.js';
import { z } from 'zod';

const router = Router();


/**
 * Record a sign-in attempt. There was previously no record of a login at all, so "who was in the
 * portal on Tuesday" had no answer, and a run of failures against one account was invisible.
 *
 * Never throws: an audit write must not be the reason somebody cannot sign in.
 */
async function recordLogin(
  req: Request,
  email: string,
  success: boolean,
  userId?: string | null,
  reason?: string,
): Promise<void> {
  try {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    await prisma.loginEvent.create({
      data: {
        userId: userId ?? null,
        email: email.toLowerCase(),
        success,
        reason: reason ?? null,
        ip: fwd || req.socket?.remoteAddress || null,
        userAgent: String(req.headers['user-agent'] || '').slice(0, 500) || null,
      },
    });
    if (success && userId) {
      await prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
    }
  } catch (err) {
    console.error('[LOGIN_AUDIT] could not record login attempt:', err);
  }
}


/**
 * Throttle password guessing.
 *
 * /auth/login had no lockout and no rate limit: an attacker could guess indefinitely, and the
 * only trace was nothing at all until LoginEvent existed. Now that every attempt is recorded, the
 * table itself is the counter — no extra store, and it survives a restart, which an in-memory
 * counter would not.
 *
 * Two limits, deliberately different:
 *   - per ACCOUNT, to stop one mailbox being ground down
 *   - per IP, higher, to stop one source spraying many accounts
 *
 * Successful sign-ins are not counted, and the window is rolling, so a legitimate user who
 * mistypes a few times is back in as soon as they get it right. Rejections are recorded but
 * excluded from the counts -- otherwise every blocked attempt would extend the lock and it would
 * never lift. Returns null when allowed, or the number of seconds to wait.
 */
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS_PER_EMAIL = 5;
const MAX_FAILS_PER_IP = 20;

function clientIpOf(req: Request): string | null {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket?.remoteAddress || null;
}

async function loginThrottleRetryAfter(req: Request, email: string): Promise<number | null> {
  try {
    const since = new Date(Date.now() - LOGIN_WINDOW_MS);
    const ip = clientIpOf(req);
    const [byEmail, byIp] = await Promise.all([
      prisma.loginEvent.count({
        where: {
          email: email.toLowerCase(), success: false,
          createdAt: { gte: since }, NOT: { reason: { in: ['throttled', 'cleared_by_admin'] } },
        },
      }),
      ip
        ? prisma.loginEvent.count({
            where: { ip, success: false, createdAt: { gte: since }, NOT: { reason: { in: ['throttled', 'cleared_by_admin'] } } },
          })
        : Promise.resolve(0),
    ]);
    if (byEmail < MAX_FAILS_PER_EMAIL && byIp < MAX_FAILS_PER_IP) return null;

    // Wait out the oldest failure in the window rather than a flat penalty, so the lock lifts
    // gradually instead of everything expiring at once.
    const oldest = await prisma.loginEvent.findFirst({
      where: {
        success: false,
        createdAt: { gte: since },
        NOT: { reason: { in: ['throttled', 'cleared_by_admin'] } },
        ...(byEmail >= MAX_FAILS_PER_EMAIL ? { email: email.toLowerCase() } : { ip: ip as string }),
      },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });
    const readyAt = (oldest?.createdAt.getTime() ?? Date.now()) + LOGIN_WINDOW_MS;
    return Math.max(1, Math.ceil((readyAt - Date.now()) / 1000));
  } catch (err) {
    // Never lock everybody out because the check itself failed.
    console.error('[LOGIN_THROTTLE] check failed, allowing the attempt:', err);
    return null;
  }
}

router.post('/login', async (req: Request, res: Response) => {
  try {
    const result = loginSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: result.error.flatten() });
    }

    const { email, password, garageId: requestedGarageId } = result.data;

    const retryAfter = await loginThrottleRetryAfter(req, email);
    if (retryAfter !== null) {
      await recordLogin(req, email, false, null, 'throttled');
      console.warn(`[LOGIN] throttled ${email.toLowerCase()} from ${clientIpOf(req)} — ${retryAfter}s`);
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({
        error: 'Too many sign-in attempts. Please wait a few minutes and try again.',
        retryAfter,
      });
    }

    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });

    if (!user) {
      await recordLogin(req, email, false, null, 'no_user');
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const matched = await bcrypt.compare(password, user.passwordHash);

    if (!matched) {
      await recordLogin(req, email, false, user.id, 'bad_password');
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    await recordLogin(req, email, true, user.id);

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      throw new Error('JWT_SECRET is not configured');
    }
    const branchRoles = sanitizeBranchRoles(user.branchRoles);
    let onboardingGarageIds = Array.isArray(user.garageAccessIds) ? [...user.garageAccessIds] : [];
    if (user.role === 'RECEPTIONMATE_STAFF') {
      const allGarages = await prisma.garage.findMany({ select: { id: true } });
      onboardingGarageIds = allGarages.map((entry) => entry.id);
    }
    // Issue an onboarding JWT NOW. Each gate (password change, agreement,
    // payment) reuses this token so the user is never logged out mid-flow.
    const onboardingToken = jwt.sign(
      {
        userId: user.id,
        email: user.email,
        role: user.role,
        branchRoles,
        garageIds: onboardingGarageIds,
      },
      secret,
      { expiresIn: '7d' },
    );

    if (user.mustChangePassword) {
      const resetToken = randomBytes(32).toString('hex');
      const resetTokenExpiry = new Date(Date.now() + 3600000);

      await prisma.user.update({
        where: { id: user.id },
        data: {
          resetToken,
          resetTokenExpiry,
        },
      });

      return res.json({
        success: true,
        passwordChangeRequired: true,
        resetToken,
        token: onboardingToken,
        user: { id: user.id, email: user.email, role: user.role, branchRoles },
      });
    }

    // Onboarding order: agreement → DD → setup wizard. Agreement comes first
    // because everything downstream is contingent on a signed contract.
    const pendingAgreement = await prisma.agreement.findFirst({
      where: { userId: user.id, status: { in: ['draft', 'sent'] } },
      select: { id: true },
    });
    if (pendingAgreement) {
      return res.json({
        success: true,
        agreementSignRequired: true,
        token: onboardingToken,
        user: { id: user.id, email: user.email, role: user.role, branchRoles },
      });
    }

    // Check if payment setup is required
    if (user.mustSetupPayment) {
      return res.json({
        success: true,
        paymentSetupRequired: true,
        token: onboardingToken,
        user: { id: user.id, email: user.email, role: user.role, branchRoles },
      });
    }

    let allowedGarageIds = Array.isArray(user.garageAccessIds) ? [...user.garageAccessIds] : [];
    if (user.role === 'RECEPTIONMATE_STAFF') {
      const allGarages = await prisma.garage.findMany({ select: { id: true } });
      allowedGarageIds = allGarages.map((entry) => entry.id);
    }
    if (allowedGarageIds.length === 0) {
      const fallback = await prisma.garage.findFirst({ select: { id: true } });
      if (!fallback) {
        return res.status(404).json({ error: 'No garages available' });
      }
      allowedGarageIds = [fallback.id];
    }

    const selectedGarageId = requestedGarageId && allowedGarageIds.includes(requestedGarageId)
      ? requestedGarageId
      : allowedGarageIds[0];

    const garage = await prisma.garage.findUnique({ where: { id: selectedGarageId } });

    if (!garage) {
      return res.status(404).json({ error: 'Garage not found' });
    }

    const accessibleGarages = await prisma.garage.findMany({
      where: { id: { in: allowedGarageIds } },
      orderBy: { name: 'asc' },
    });


    const token = jwt.sign(
      {
        userId: user.id,
        email: user.email,
        garageIds: allowedGarageIds,
        role: user.role,
        branchRoles,
      },
      secret,
      { expiresIn: '7d' },
    );

    res.json({
      success: true,
      token,
      user: { id: user.id, email: user.email, role: user.role, branchRoles },
      selectedGarageId,
      garages: accessibleGarages.map((entry) => ({ id: entry.id, name: entry.name })),
    });
  } catch (error) {
    if (process.env.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.error('Login failed', error);
    }
    res.status(500).json({ error: 'Login failed' });
  }
});

router.post('/request-password-reset', async (req: Request, res: Response) => {
  try {
    const schema = z.object({ email: z.string().email() });
    const result = schema.safeParse(req.body);
    
    if (!result.success) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    const { email } = result.data;
    const user = await prisma.user.findUnique({ where: { email } });

    // Always return success to prevent email enumeration
    if (!user) {
      return res.json({ success: true, message: 'If an account exists, a reset link has been sent.' });
    }

    // Generate reset token
    const resetToken = randomBytes(32).toString('hex');
    const resetTokenExpiry = new Date(Date.now() + 3600000); // 1 hour from now

    await prisma.user.update({
      where: { id: user.id },
      data: {
        resetToken,
        resetTokenExpiry,
      },
    });

    // Send reset email
    const portalUrl = process.env.PORTAL_URL || 'http://portal.receptionmate.co.uk';
    const resetUrl = `${portalUrl}/reset-password?token=${resetToken}`;

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reset Your Password</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #09203c;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #09203c;">
    <tr>
      <td style="padding: 40px 20px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" style="margin: 0 auto; background-color: #1a3a52; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.5);">
          <tr>
            <td style="padding: 0; background: linear-gradient(135deg, #3126cf 0%, #2419a8 100%);">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td style="text-align: center; padding: 32px;">
                    <h2 style="margin: 0; font-size: 24px; font-weight: 600; color: #ffffff;">
                      Password Reset Request
                    </h2>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <tr>
            <td style="padding: 32px;">
              <p style="margin: 0 0 16px; font-size: 15px; line-height: 1.6; color: #e2e8f0;">
                You requested a password reset for your ReceptionMate Portal account.
              </p>
              <p style="margin: 0 0 24px; font-size: 15px; line-height: 1.6; color: #e2e8f0;">
                Click the button below to reset your password. This link will expire in 1 hour.
              </p>
              <div style="text-align: center; margin: 32px 0;">
                <a href="${resetUrl}" style="display: inline-block; background-color: #3126cf; color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 16px;">
                  Reset Password
                </a>
              </div>
              <p style="margin: 24px 0 0; font-size: 13px; line-height: 1.6; color: #94a3b8;">
                If you didn't request this, you can safely ignore this email. Your password will not be changed.
              </p>
            </td>
          </tr>
          
          <tr>
            <td style="padding: 24px 32px; text-align: center; color: #64748b; font-size: 12px; border-top: 1px solid #1e4a66;">
              <p style="margin: 0;">
                This is an automated email from ReceptionMate
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;

    const text = `
Password Reset Request

You requested a password reset for your ReceptionMate Portal account.

Click the link below to reset your password. This link will expire in 1 hour:
${resetUrl}

If you didn't request this, you can safely ignore this email.

---
ReceptionMate
`;

    await sendEmail({
      to: [email],
      subject: 'Reset Your ReceptionMate Portal Password',
      html,
      text,
    });

    res.json({ success: true, message: 'If an account exists, a reset link has been sent.' });
  } catch (error) {
    console.error('Password reset request failed:', error);
    res.status(500).json({ error: 'Failed to process password reset request' });
  }
});

router.post('/reset-password', async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      token: z.string().min(1),
      password: z.string().min(8),
    });
    const result = schema.safeParse(req.body);
    
    if (!result.success) {
      return res.status(400).json({ error: 'Invalid request' });
    }

    const { token, password } = result.data;

    const user = await prisma.user.findFirst({
      where: {
        resetToken: token,
        resetTokenExpiry: { gt: new Date() },
      },
    });

    if (!user) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        mustChangePassword: false,
        resetToken: null,
        resetTokenExpiry: null,
      },
    });

    // Tell the frontend what the next onboarding step is so it can route
    // the user forward without forcing them to log in again.
    const pendingAgreement = await prisma.agreement.findFirst({
      where: { userId: user.id, status: { in: ['draft', 'sent'] } },
      select: { id: true },
    });

    // Auto-login: issue a session so the reset page can drop the customer straight into the
    // portal (self-serve "choose a password" flow) instead of bouncing them to the login screen.
    let session: unknown = null;
    const secret = process.env.JWT_SECRET;
    if (secret) {
      const allowedGarageIds = Array.isArray(updatedUser.garageAccessIds) ? updatedUser.garageAccessIds : [];
      const branchRoles = sanitizeBranchRoles(updatedUser.branchRoles);
      const accessibleGarages = await prisma.garage.findMany({
        where: { id: { in: allowedGarageIds } },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      });
      const authToken = jwt.sign(
        { userId: updatedUser.id, email: updatedUser.email, garageIds: allowedGarageIds, role: updatedUser.role, branchRoles },
        secret,
        { expiresIn: '12h' },
      );
      session = {
        token: authToken,
        selectedGarageId: allowedGarageIds[0] ?? null,
        garages: accessibleGarages,
        user: { id: updatedUser.id, email: updatedUser.email, role: updatedUser.role, branchRoles },
      };
    }

    res.json({
      success: true,
      message: 'Password reset successfully',
      session,
      nextStep: pendingAgreement
        ? 'agreement'
        : updatedUser.mustSetupPayment
        ? 'payment'
        : 'dashboard',
    });
  } catch (error) {
    console.error('Password reset failed:', error);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

router.post('/verify-magic-link', async (req: Request, res: Response) => {
  try {
    const schema = z.object({
      token: z.string().min(1),
    });
    const result = schema.safeParse(req.body);

    if (!result.success) {
      return res.status(400).json({ error: 'Invalid request' });
    }

    const { token } = result.data;

    console.log('[MAGIC LINK] Verifying token:', token.substring(0, 20) + '...');
    console.log('[MAGIC LINK] Full token:', token);
    console.log('[MAGIC LINK] Current time:', new Date().toISOString());

    // First check if token exists at all
    const userWithToken = await prisma.user.findFirst({
      where: { resetToken: token },
      select: {
        email: true,
        resetToken: true,
        resetTokenExpiry: true,
      }
    });

    console.log('[MAGIC LINK] Token exists in DB:', !!userWithToken);
    if (userWithToken) {
      console.log('[MAGIC LINK] Token user:', userWithToken.email);
      console.log('[MAGIC LINK] Token expiry:', userWithToken.resetTokenExpiry?.toISOString());
    }

    // Find user with this reset token (reusing for magic links)
    const user = await prisma.user.findFirst({
      where: {
        resetToken: token,
        resetTokenExpiry: { gt: new Date() },
      },
    });

    console.log('[MAGIC LINK] User found with expiry check:', !!user, user ? user.email : 'none');

    if (!user) {
      console.log('[MAGIC LINK] Token not found or expired');
      return res.status(400).json({ error: 'Invalid or expired link' });
    }

    console.log('[MAGIC LINK] Token valid, logging in user:', user.email);

    // Clear the used token
    await prisma.user.update({
      where: { id: user.id },
      data: {
        resetToken: null,
        resetTokenExpiry: null,
      }
    });

    // Generate JWT token for the user
    const jwtSecret = process.env.JWT_SECRET || 'default-secret-change-me';
    const authToken = jwt.sign(
      {
        userId: user.id,
        email: user.email,
        role: user.role,
      },
      jwtSecret,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      token: authToken,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        garageAccessIds: user.garageAccessIds,
        branchRoles: sanitizeBranchRoles(user.branchRoles),
        mustChangePassword: user.mustChangePassword,
        mustSetupPayment: user.mustSetupPayment,
      }
    });
  } catch (error) {
    console.error('Magic link verification failed:', error);
    res.status(500).json({ error: 'Failed to verify link' });
  }
});

export default router;