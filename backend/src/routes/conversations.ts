import type { Request, Response } from 'express';
import { Router } from 'express';
import axios from 'axios';
import { prisma } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { resolveAllowedGarages } from '../utils/auth.js';

const router = Router();

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

function isStaff(req: Request): boolean {
  return req.user?.role === 'RECEPTIONMATE_STAFF';
}

function isManagerOrStaff(req: Request): boolean {
  return req.user?.role === 'RECEPTIONMATE_STAFF' || req.user?.role === 'MANAGER';
}

/** Returns the set of garageIds the user may access, or null meaning "all" (staff). */
function getAllowedGarages(req: Request): string[] | null {
  if (isStaff(req)) return null;
  return resolveAllowedGarages(req.user);
}

/** Check the authenticated user has access to a specific garageId. */
function hasGarageAccess(req: Request, garageId: string): boolean {
  if (isStaff(req)) return true;
  const allowed = resolveAllowedGarages(req.user);
  return allowed.includes(garageId);
}

// ---------------------------------------------------------------------------
// GET /api/conversations
// ---------------------------------------------------------------------------

router.get('/conversations', authenticate, async (req: Request, res: Response) => {
  try {
    const { status, garageId, platform } = req.query;

    const allowedGarages = getAllowedGarages(req);

    // Build where clause
    const where: Record<string, unknown> = {};

    if (allowedGarages !== null) {
      // Non-staff: enforce garage access
      if (garageId) {
        if (!allowedGarages.includes(garageId as string)) {
          return res.status(403).json({ error: 'Access denied' });
        }
        where.garageId = garageId;
      } else {
        where.garageId = { in: allowedGarages };
      }
    } else if (garageId) {
      where.garageId = garageId;
    }

    if (status) where.status = status;
    if (platform) where.platform = platform;

    const conversations = await prisma.chatConversation.findMany({
      where,
      include: {
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
      orderBy: { lastMessageAt: 'desc' },
    });

    const result = conversations.map((c) => ({
      id: c.id,
      garageId: c.garageId,
      platform: c.platform,
      customerName: c.customerName,
      customerPhone: c.customerPhone,
      platformUserId: c.platformUserId,
      status: c.status,
      agentPaused: c.agentPaused,
      needsAttention: c.needsAttention,
      confirmedBooking: c.confirmedBooking,
      unreadCount: c.unreadCount,
      lastMessageAt: c.lastMessageAt,
      lastMessage: c.messages[0]?.content?.slice(0, 120) ?? null,
      createdAt: c.createdAt,
    }));

    res.json({ conversations: result });
  } catch (error) {
    console.error('[CONVERSATIONS] GET /conversations error:', error);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/conversations/:id/messages
// ---------------------------------------------------------------------------

router.get('/conversations/:id/messages', authenticate, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const conversation = await prisma.chatConversation.findUnique({ where: { id } });
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

    if (!hasGarageAccess(req, conversation.garageId)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Reset unread count when staff views messages
    await prisma.chatConversation.update({
      where: { id },
      data: { unreadCount: 0 },
    });

    const messages = await prisma.chatMessage.findMany({
      where: { conversationId: id },
      orderBy: { createdAt: 'asc' },
    });

    res.json({ conversation, messages });
  } catch (error) {
    console.error('[CONVERSATIONS] GET /conversations/:id/messages error:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/conversations/:id/reply
// ---------------------------------------------------------------------------

router.post('/conversations/:id/reply', authenticate, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { message } = req.body;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message is required' });
    }

    if (!isManagerOrStaff(req)) {
      return res.status(403).json({ error: 'Manager or staff access required' });
    }

    const conversation = await prisma.chatConversation.findUnique({ where: { id } });
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

    if (!hasGarageAccess(req, conversation.garageId)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Save staff message
    await prisma.chatMessage.create({
      data: { conversationId: id, role: 'staff', content: message },
    });

    // Pause agent and clear unread count
    await prisma.chatConversation.update({
      where: { id },
      data: { agentPaused: true, unreadCount: 0, lastMessageAt: new Date() },
    });

    // Send via the customer's channel (fire-and-forget — don't fail the request if delivery fails)
    void sendReplyToChannel(conversation, message).catch((err) =>
      console.error(`[CONVERSATIONS] Failed to send reply via ${conversation.platform}:`, err)
    );

    res.json({ success: true });
  } catch (error) {
    console.error('[CONVERSATIONS] POST /conversations/:id/reply error:', error);
    res.status(500).json({ error: 'Failed to send reply' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/conversations/:id/resume
// ---------------------------------------------------------------------------

router.post('/conversations/:id/resume', authenticate, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const conversation = await prisma.chatConversation.findUnique({ where: { id } });
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

    if (!hasGarageAccess(req, conversation.garageId)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    await prisma.chatConversation.update({
      where: { id },
      data: { agentPaused: false, needsAttention: false, agentPausedUntil: null },
    });

    res.json({ success: true });
  } catch (error) {
    console.error('[CONVERSATIONS] POST /conversations/:id/resume error:', error);
    res.status(500).json({ error: 'Failed to resume conversation' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/conversations/:id/resolve
// ---------------------------------------------------------------------------

router.post('/conversations/:id/resolve', authenticate, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const conversation = await prisma.chatConversation.findUnique({ where: { id } });
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

    if (!hasGarageAccess(req, conversation.garageId)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    await prisma.chatConversation.update({
      where: { id },
      data: { status: 'resolved' },
    });

    res.json({ success: true });
  } catch (error) {
    console.error('[CONVERSATIONS] POST /conversations/:id/resolve error:', error);
    res.status(500).json({ error: 'Failed to resolve conversation' });
  }
});

// ---------------------------------------------------------------------------
// Platform reply dispatcher
// ---------------------------------------------------------------------------

async function sendReplyToChannel(
  conversation: {
    platform: string;
    garageId: string;
    customerPhone: string | null;
    platformUserId: string | null;
  },
  message: string
): Promise<void> {
  const { platform, garageId, customerPhone, platformUserId } = conversation;

  if (platform === 'widget' || platform === 'web') {
    // Widget — message is already in DB; the client polls for new messages.
    return;
  }

  // Fetch the social media connection for this garage + platform
  const connection = await prisma.socialMediaConnection.findFirst({
    where: { garageId, platform, isActive: true },
  });

  if (!connection) {
    console.warn(`[CONVERSATIONS] No active ${platform} connection for garage ${garageId}`);
    return;
  }

  if (platform === 'whatsapp') {
    if (!customerPhone || !connection.whatsappPhoneNumberId) return;
    await axios.post(
      `https://graph.facebook.com/v18.0/${connection.whatsappPhoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        to: customerPhone,
        type: 'text',
        text: { body: message },
      },
      {
        headers: {
          Authorization: `Bearer ${connection.accessToken}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    );
    return;
  }

  if (platform === 'facebook' || platform === 'instagram') {
    if (!platformUserId) return;
    await axios.post(
      'https://graph.facebook.com/v18.0/me/messages',
      {
        recipient: { id: platformUserId },
        message: { text: message },
      },
      {
        headers: {
          Authorization: `Bearer ${connection.accessToken}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    );
    return;
  }

  if (platform === 'livechat') {
    if (!platformUserId) return;
    const entityId = connection.pageId || '';
    await axios.post(
      'https://api.livechatinc.com/v3.5/agent/action/send_event',
      {
        chat_id: platformUserId,
        event: { type: 'message', text: message, visibility: 'all' },
      },
      {
        headers: {
          Authorization: `Bearer ${connection.accessToken}`,
          'X-Region': 'dal',
          'Content-Type': 'application/json',
          'Account-Id': entityId,
        },
        timeout: 15000,
      }
    );
    return;
  }

  console.warn(`[CONVERSATIONS] Unsupported platform for reply: ${platform}`);
}

export default router;
