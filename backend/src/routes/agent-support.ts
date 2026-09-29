/**
 * What the support agent may look at once it knows who it is talking to.
 *
 * Endpoints:
 *   POST /api/agent/support/identify        — who is this? (caller number or code)
 *   GET  /api/agent/support/context/:id     — their recent calls + configuration
 *   POST /api/agent/support/change-request  — what the agent WOULD have changed
 *
 * READ ONLY, deliberately. Identification here is a phone number that can be
 * spoofed or five digits said out loud; neither is strong enough to let a voice
 * on the phone change a live agent's configuration. Where the agent would have
 * changed something it posts a change request instead, which becomes a ticket
 * describing what it would have done, and a person decides.
 *
 * Authenticated with the same WEBHOOK_SECRET header the call webhook uses, so
 * the agents need no new credential.
 */
import type { Request, Response, NextFunction } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { TicketCategory, TicketPriority } from '@prisma/client';
import { prisma } from '../db.js';
import {
  identifyByCallerNumber,
  identifyBySupportCode,
  tooManyAttempts,
  getOrCreateSupportCode,
} from '../services/supportIdentity.js';
import { authenticate } from '../middleware/auth.js';
import { createCallTicket } from '../services/callTickets.js';

const router = Router();

const requireWebhookSecret = (req: Request, res: Response, next: NextFunction) => {
  const configured = process.env.WEBHOOK_SECRET;
  // Unset means the box has not been given one; refuse rather than run open,
  // because unlike the call webhook this hands out customer data.
  if (!configured) return res.status(503).json({ error: 'Not configured' });
  const supplied = req.headers['x-webhook-secret'] ?? req.headers['webhook-secret'];
  const value = Array.isArray(supplied) ? supplied[0] : supplied;
  if (value !== configured) return res.status(401).json({ error: 'Unauthorised' });
  return next();
};

router.use('/agent/support', requireWebhookSecret);

// ─── Who is this? ───────────────────────────────────────────────────────────

const identifySchema = z.object({
  callerNumber: z.string().trim().max(32).optional(),
  supportCode: z.string().trim().max(16).optional(),
});

router.post('/agent/support/identify', async (req: Request, res: Response) => {
  const parsed = identifySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });
  const { callerNumber, supportCode } = parsed.data;

  // The number first: it costs them nothing and they did not have to remember it.
  const byNumber = await identifyByCallerNumber(callerNumber);
  if (byNumber) {
    console.log(`[AGENT_SUPPORT] identified ${byNumber.garageName} by caller number`);
    return res.json({ identified: true, ...byNumber });
  }

  if (supportCode) {
    if (tooManyAttempts(callerNumber)) {
      console.warn(`[AGENT_SUPPORT] too many wrong codes from ${callerNumber ?? 'unknown'}`);
      return res.json({
        identified: false,
        blocked: true,
        // Said to the caller, so it is an apology rather than an accusation.
        reason: 'Too many attempts. Ask them to check the code in the portal and try again later, or take a message.',
      });
    }
    const byCode = await identifyBySupportCode(supportCode, callerNumber);
    if (byCode) {
      console.log(`[AGENT_SUPPORT] identified ${byCode.garageName} by support code`);
      return res.json({ identified: true, ...byCode });
    }
  }

  return res.json({
    identified: false,
    reason: callerNumber
      ? 'That number is not one we hold. Ask for the five-digit support code from the portal.'
      : 'No number and no code. Ask for the five-digit support code from the portal.',
  });
});

// ─── What they can be told about themselves ─────────────────────────────────

router.get('/agent/support/context/:garageId', async (req: Request, res: Response) => {
  const garageId = req.params.garageId;
  const garage = await prisma.garage.findUnique({
    where: { id: garageId },
    select: { id: true, name: true, twilioNumber: true },
  });
  if (!garage) return res.status(404).json({ error: 'Not found' });

  const [config, calls] = await Promise.all([
    prisma.agentConfiguration.findUnique({
      where: { garageId },
      select: {
        branchName: true, agentName: true, phoneNumber: true, emailAddress: true,
        greetingLine: true, weeklyOpeningHours: true, transferNumber: true,
        humanEscalation: true, bookingLeadTimeDays: true, updatedAt: true,
      },
    }),
    prisma.call.findMany({
      where: { garageId },
      orderBy: { createdAt: 'desc' },
      take: 10,
      // No transcript and no recording: the agent is explaining what happened,
      // not reading a caller's words back to somebody on the phone.
      select: {
        id: true, createdAt: true, durationSeconds: true, callType: true,
        fromNumber: true, customerName: true, confirmedBooking: true, summary: true,
      },
    }),
  ]);

  return res.json({
    garage: { id: garage.id, name: garage.name, agentNumber: garage.twilioNumber },
    configuration: config,
    recentCalls: calls.map((c) => ({
      ...c,
      summary: (c.summary ?? '').slice(0, 600),
    })),
  });
});

// ─── What the agent would have changed ──────────────────────────────────────

const changeRequestSchema = z.object({
  garageId: z.string().trim().min(1),
  /** In the agent's own words: what the caller asked for and what it would have done. */
  summary: z.string().trim().min(1).max(4000),
  callId: z.string().trim().max(64).optional(),
  callerPhone: z.string().trim().max(32).optional(),
  callerName: z.string().trim().max(120).optional(),
});

router.post('/agent/support/change-request', async (req: Request, res: Response) => {
  const parsed = changeRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
  const { garageId, summary, callId, callerPhone, callerName } = parsed.data;

  const garage = await prisma.garage.findUnique({ where: { id: garageId }, select: { name: true } });
  if (!garage) return res.status(404).json({ error: 'Not found' });

  const base = (process.env.PORTAL_BASE_URL || 'https://portal.receptionmate.co.uk').replace(/\/$/, '');
  await createCallTicket({
    garageId,
    garageName: garage.name,
    callerPhone: callerPhone ?? null,
    callerName: callerName ?? null,
    title: `Change requested on a support call — ${garage.name}`.slice(0, 300),
    body: [
      'The caller was identified and asked for a change. The agent can only read, so it did not make it.',
      '',
      summary,
      callId ? `\n${base}/calls/${callId}` : '',
    ].filter(Boolean).join('\n'),
    priority: TicketPriority.normal,
    category: TicketCategory.setup_help,
  });

  console.log(`[AGENT_SUPPORT] change request logged for ${garage.name}`);
  return res.status(201).json({ ok: true });
});

// ─── The garage's own code, for the portal to show them ─────────────────────
// Signed-in, so it sits behind the normal auth rather than the agent secret.
// Minted on first view: a garage that never rings support never gets one.

export const supportCodeRouter = Router();

supportCodeRouter.get(
  '/garages/:garageId/support-code',
  authenticate,
  async (req: Request, res: Response) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorised' });
    const { garageId } = req.params;
    // Their own garage only. Staff see any.
    const allowed = req.user.role === 'RECEPTIONMATE_STAFF'
      || (Array.isArray(req.user.garageIds) && req.user.garageIds.includes(garageId));
    if (!allowed) return res.status(403).json({ error: 'No access to that garage' });

    const garage = await prisma.garage.findUnique({ where: { id: garageId }, select: { id: true } });
    if (!garage) return res.status(404).json({ error: 'Not found' });

    const code = await getOrCreateSupportCode(garageId);
    return res.json({ supportCode: code });
  },
);

export default router;
