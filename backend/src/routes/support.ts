// In-portal support chat between a portal user (the customer) and the
// ReceptionMate team. One conversation per user — keeps context together.
//
// Endpoints:
//   GET    /api/support/me              — current user's thread + messages
//   POST   /api/support/me/messages     — user sends a message
//   POST   /api/support/me/read         — mark thread read for the user
//   GET    /api/admin/support           — list all threads for the admin inbox
//   GET    /api/admin/support/:id       — one thread + messages
//   POST   /api/admin/support/:id/messages — staff sends a reply
//   POST   /api/admin/support/:id/read  — mark thread read for staff

import type { Request, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { generateSupportAiReply } from '../services/supportAi.js';
import { buildUserContext } from '../services/supportContext.js';
import { sendSupportEscalationEmail } from '../services/supportEscalationEmail.js';

const router = Router();

const messageSchema = z.object({
  body: z.string().trim().min(1).max(4000),
  // Currently-selected branch in the portal — used so the AI sees the right
  // agent config for users whose access isn't expressed via garageAccessIds
  // (e.g. RM staff, or users with branch-role grants).
  selectedGarageId: z.string().min(1).optional(),
});

async function getOrCreateConversation(userId: string) {
  // A JWT can outlive its user (e.g. an account deleted after login). Upserting a
  // SupportConversation with a userId that has no matching User row throws a
  // foreign-key error (P2003) that, unhandled, used to crash the whole backend.
  // Treat a missing user as an expired session — callers return 401.
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) return null;
  return prisma.supportConversation.upsert({
    where: { userId },
    update: {},
    create: { userId },
  });
}

// ---------------------------------------------------------------------------
// USER (customer) endpoints
// ---------------------------------------------------------------------------

router.get('/support/me', authenticate, async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorised' });

  const conversation = await getOrCreateConversation(req.user.userId);
  if (!conversation) return res.status(401).json({ error: 'Your session has expired. Please log in again.' });
  const messages = await prisma.supportMessage.findMany({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: 'asc' },
    take: 200,
    include: { sender: { select: { email: true } } },
  });

  return res.json({
    conversation: {
      id: conversation.id,
      lastMessageAt: conversation.lastMessageAt,
      lastMessageText: conversation.lastMessageText,
      unreadForUser: conversation.unreadForUser,
    },
    messages,
  });
});

router.post('/support/me/messages', authenticate, async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorised' });
  const parsed = messageSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
  }

  const conversation = await getOrCreateConversation(req.user.userId);
  if (!conversation) return res.status(401).json({ error: 'Your session has expired. Please log in again.' });
  const customerMessage = await prisma.supportMessage.create({
    data: {
      conversationId: conversation.id,
      senderRole: 'customer',
      senderUserId: req.user.userId,
      channel: 'portal',
      body: parsed.data.body,
    },
  });

  // Leah keeps replying regardless of conversation status. Escalation is a
  // background event (emails the team) but doesn't stop the AI from helping
  // — the user is told the team will email them back; they can keep chatting.

  // AI-handled branch. No hard turn cap — the AI keeps answering while it's
  // confident. Escalation is driven by:
  //   (a) explicit keyword check inside generateSupportAiReply
  //   (b) the AI itself returning [[ESCALATE]] when stuck
  let aiReply: { reply: string; escalate: boolean };
  try {
    const history = await prisma.supportMessage.findMany({
      where: { conversationId: conversation.id, senderRole: { in: ['customer', 'ai', 'staff'] } },
      orderBy: { createdAt: 'asc' },
      take: 30,
    });
    // Exclude the message we just inserted so the AI sees the history then
    // responds to the new message as `userMessage`.
    const historyForAi = history
      .filter((m) => m.id !== customerMessage.id)
      .map((m) => ({
        role: (m.senderRole === 'customer' ? 'user' : 'assistant') as 'user' | 'assistant',
        content: m.body,
      }));
    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    // Fetched fresh every turn so config changes mid-conversation are reflected.
    const userContext = await buildUserContext(req.user.userId, parsed.data.selectedGarageId).catch((err) => {
      console.error('[SUPPORT_AI] buildUserContext failed:', err);
      return undefined;
    });
    aiReply = await generateSupportAiReply({
      history: historyForAi,
      userMessage: parsed.data.body,
      customerEmail: user?.email ?? '',
      userContext,
    });
  } catch (err) {
    console.error('[SUPPORT_AI] Generation failed:', err);
    aiReply = {
      reply:
        "Sorry — our AI assistant is having a moment. I'll get the team to follow up here shortly.",
      escalate: true,
    };
  }

  const assistantMessage = await prisma.supportMessage.create({
    data: {
      conversationId: conversation.id,
      senderRole: 'ai',
      channel: 'portal',
      body: aiReply.reply,
    },
  });

  // Only fire the team email on the FIRST escalation per conversation —
  // i.e. when status transitions from 'ai' → 'awaiting_staff'. If the
  // conversation is already in awaiting_staff and Leah re-flags, the team
  // already knows; don't spam them.
  const isFirstEscalation =
    aiReply.escalate && conversation.status !== 'awaiting_staff' && conversation.status !== 'staff_handled';

  let systemMessage = null;
  if (isFirstEscalation) {
    systemMessage = await prisma.supportMessage.create({
      data: {
        conversationId: conversation.id,
        senderRole: 'system',
        channel: 'portal',
        body: 'Support ticket created — the ReceptionMate team will email you back shortly.',
      },
    });
  }

  await prisma.supportConversation.update({
    where: { id: conversation.id },
    data: {
      lastMessageAt: (systemMessage ?? assistantMessage).createdAt,
      lastMessageText: aiReply.reply.slice(0, 280),
      aiTurns: { increment: aiReply.escalate ? 0 : 1 },
      status: aiReply.escalate ? 'awaiting_staff' : conversation.status === 'ai' ? 'ai' : conversation.status,
      unreadForStaff: aiReply.escalate ? { increment: 1 } : conversation.unreadForStaff,
      unreadForUser: { increment: 1 },
    },
  });

  // Fire-and-forget team email so the AI response isn't delayed by Mailgun.
  if (isFirstEscalation) {
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { email: true },
    });
    void sendSupportEscalationEmail({
      conversationId: conversation.id,
      triggerMessage: parsed.data.body,
      customerEmail: user?.email ?? 'unknown',
    });
  }

  return res.status(201).json({
    messages: systemMessage
      ? [customerMessage, assistantMessage, systemMessage]
      : [customerMessage, assistantMessage],
    status: aiReply.escalate ? 'awaiting_staff' : conversation.status,
  });
});

router.post('/support/me/read', authenticate, async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorised' });
  const conversation = await getOrCreateConversation(req.user.userId);
  if (!conversation) return res.status(401).json({ error: 'Your session has expired. Please log in again.' });
  await prisma.supportConversation.update({
    where: { id: conversation.id },
    data: { unreadForUser: 0 },
  });
  return res.json({ success: true });
});

// ---------------------------------------------------------------------------
// ADMIN (staff) endpoints
// ---------------------------------------------------------------------------

router.get('/admin/support', authenticate, requireAdmin, async (_req: Request, res: Response) => {
  const conversations = await prisma.supportConversation.findMany({
    orderBy: [{ unreadForStaff: 'desc' }, { lastMessageAt: 'desc' }],
    take: 200,
    include: { user: { select: { email: true } } },
  });
  return res.json({ conversations });
});

router.get('/admin/support/:id', authenticate, requireAdmin, async (req: Request, res: Response) => {
  const conversation = await prisma.supportConversation.findUnique({
    where: { id: req.params.id },
    include: { user: { select: { id: true, email: true, role: true, createdAt: true } } },
  });
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

  const messages = await prisma.supportMessage.findMany({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: 'asc' },
    take: 500,
    include: { sender: { select: { email: true } } },
  });
  return res.json({ conversation, messages });
});

router.post('/admin/support/:id/messages', authenticate, requireAdmin, async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorised' });
  const parsed = messageSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
  }

  const conversation = await prisma.supportConversation.findUnique({ where: { id: req.params.id } });
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

  const message = await prisma.supportMessage.create({
    data: {
      conversationId: conversation.id,
      senderRole: 'staff',
      senderUserId: req.user.userId,
      channel: 'portal',
      body: parsed.data.body,
    },
  });

  await prisma.supportConversation.update({
    where: { id: conversation.id },
    data: {
      lastMessageAt: message.createdAt,
      lastMessageText: parsed.data.body.slice(0, 280),
      unreadForUser: { increment: 1 },
      unreadForStaff: 0,
    },
  });

  return res.status(201).json({ message });
});

router.post('/admin/support/:id/read', authenticate, requireAdmin, async (req: Request, res: Response) => {
  const conversation = await prisma.supportConversation.findUnique({ where: { id: req.params.id } });
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
  await prisma.supportConversation.update({
    where: { id: conversation.id },
    data: { unreadForStaff: 0 },
  });
  return res.json({ success: true });
});

export default router;
