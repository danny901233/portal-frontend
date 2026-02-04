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

router.post('/login', async (req: Request, res: Response) => {
  try {
    const result = loginSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: result.error.flatten() });
    }

    const { email, password, garageId: requestedGarageId } = result.data;

    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const matched = await bcrypt.compare(password, user.passwordHash);

    if (!matched) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

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
        user: { id: user.id, email: user.email, role: user.role, branchRoles: sanitizeBranchRoles(user.branchRoles) },
      });
    }

    // TODO: Add payment setup check after database migration
    // if (user.mustSetupPayment) { ... }

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


    const branchRoles = sanitizeBranchRoles(user.branchRoles);

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      throw new Error('JWT_SECRET is not configured');
    }

    const token = jwt.sign(
      {
        userId: user.id,
        email: user.email,
        garageIds: allowedGarageIds,
        role: user.role,
        branchRoles,
      },
      secret,
      { expiresIn: '12h' },
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

    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        mustChangePassword: false,
        resetToken: null,
        resetTokenExpiry: null,
      },
    });

    res.json({ success: true, message: 'Password reset successfully' });
  } catch (error) {
    console.error('Password reset failed:', error);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

export default router;