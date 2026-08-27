import type { Request, Response } from 'express';
import { Router } from 'express';
import axios from 'axios';
import { prisma } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { resolveAllowedGarages } from '../utils/auth.js';
import { notifyUser } from '../utils/push.js';
import { sendEmail } from '../utils/email.js';
import { sendDiscordNotification, DISCORD_COLORS } from '../utils/discord.js';
import { chatFeedbackSchema } from '../utils/validators.js';

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
    const { status, garageId, platform, enquiryType, assigneeId } = req.query;

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
    if (enquiryType) where.enquiryType = enquiryType;

    // "mine" is a sugar for the caller's own userId — saves the client having to
    // pass its own id back. "unassigned" filters the shared pool.
    if (assigneeId === 'mine') {
      where.assigneeId = req.user?.userId ?? null;
    } else if (assigneeId === 'unassigned') {
      where.assigneeId = null;
    } else if (typeof assigneeId === 'string' && assigneeId) {
      where.assigneeId = assigneeId;
    }

    const conversations = await prisma.chatConversation.findMany({
      where,
      include: {
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        assignee: {
          select: { id: true, email: true },
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
      enquiryType: c.enquiryType,
      assigneeId: c.assigneeId,
      assignee: c.assignee ? { id: c.assignee.id, email: c.assignee.email } : null,
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

    // Chat-agent tool calls for the observability timeline (UI interleaves by createdAt).
    const toolCalls = await prisma.chatToolCall.findMany({
      where: { conversationId: id },
      orderBy: { createdAt: 'asc' },
    });

    res.json({ conversation, messages, toolCalls });
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

    // Save staff message (record who sent it so the inbox can show the name)
    await prisma.chatMessage.create({
      data: {
        conversationId: id,
        role: 'staff',
        content: message,
        staffUserId: req.user?.userId ?? null,
        staffUserEmail: req.user?.email ?? null,
      },
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
// POST /api/conversations/:id/messages  (alias for /reply — used by messages page)
// ---------------------------------------------------------------------------

router.post('/conversations/:id/messages', authenticate, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { message, content } = req.body;
    const text = message ?? content;

    if (!text || typeof text !== 'string') {
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

    await prisma.chatMessage.create({
      data: {
        conversationId: id,
        role: 'staff',
        content: text,
        staffUserId: req.user?.userId ?? null,
        staffUserEmail: req.user?.email ?? null,
      },
    });

    await prisma.chatConversation.update({
      where: { id },
      data: { agentPaused: true, unreadCount: 0, lastMessageAt: new Date() },
    });

    void sendReplyToChannel(conversation, text).catch((err) =>
      console.error(`[CONVERSATIONS] Failed to send reply via ${conversation.platform}:`, err)
    );

    res.json({ success: true });
  } catch (error) {
    console.error('[CONVERSATIONS] POST /conversations/:id/messages error:', error);
    res.status(500).json({ error: 'Failed to send message' });
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
// POST /api/conversations/:id/assign
// ---------------------------------------------------------------------------
//
// Assign a conversation to a garage user, or unassign it (assigneeId = null).
// Rules from Dan's brief:
//   - Assignment is ownership, NOT takeover — the AI keeps running. Silencing
//     the AI is a separate, existing action (agentPaused).
//   - The assignee must have access to this conversation's garage. A user who
//     later loses access falls back to "unassigned" via the FK's SET NULL.
//   - "Unassigned" is a shared queue — no round-robin, no auto-assignment.
//   - Notify the assignee by push + email, UNLESS they assigned it to
//     themselves (self-assign is silent).
//   - Assignment is internal to the garage. The customer never sees it.

router.post('/conversations/:id/assign', authenticate, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { assigneeId } = req.body as { assigneeId: string | null };

    if (assigneeId !== null && typeof assigneeId !== 'string') {
      return res.status(400).json({ error: 'assigneeId must be a user id string or null' });
    }

    const conversation = await prisma.chatConversation.findUnique({
      where: { id },
      include: { garage: { select: { id: true, name: true } } },
    });
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

    if (!hasGarageAccess(req, conversation.garageId)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Validate the new assignee (if any) has access to this garage.
    let assignee: { id: string; email: string; notificationEmail: string | null } | null = null;
    if (assigneeId) {
      const user = await prisma.user.findUnique({
        where: { id: assigneeId },
        select: { id: true, email: true, notificationEmail: true, garageAccessIds: true, role: true },
      });
      if (!user) return res.status(404).json({ error: 'Assignee user not found' });
      const staff = user.role === 'RECEPTIONMATE_STAFF';
      const hasAccess = staff || user.garageAccessIds.includes(conversation.garageId);
      if (!hasAccess) {
        return res.status(400).json({ error: 'Assignee does not have access to this garage' });
      }
      assignee = { id: user.id, email: user.email, notificationEmail: user.notificationEmail };
    }

    const prevAssigneeId = conversation.assigneeId;
    await prisma.chatConversation.update({
      where: { id },
      data: { assigneeId: assigneeId ?? null },
    });

    // Fire-and-forget notifications. Skip when: unassigning, no-op reassign,
    // or the actor assigned it to themselves.
    if (assignee && assignee.id !== prevAssigneeId && assignee.id !== req.user?.userId) {
      const who =
        conversation.customerName?.trim() ||
        conversation.customerPhone?.trim() ||
        'A customer';
      const garageName = conversation.garage?.name || 'your garage';
      const platformLabel =
        conversation.platform === 'whatsapp'
          ? 'WhatsApp'
          : conversation.platform === 'facebook'
          ? 'Facebook'
          : conversation.platform === 'instagram'
          ? 'Instagram'
          : conversation.platform === 'livechat'
          ? 'Live chat'
          : conversation.platform === 'widget' || conversation.platform === 'web'
          ? 'Web chat'
          : conversation.platform;

      void notifyUser(assignee.id, {
        title: `Assigned: ${who}`,
        body: `${platformLabel} conversation at ${garageName} — tap to open.`,
        data: { type: 'message', conversationId: id, garageId: conversation.garageId },
      });

      const emailTo = assignee.notificationEmail || assignee.email;
      const subject = `You've been assigned a ${platformLabel} conversation`;
      const openUrl = `${(process.env.PORTAL_BASE_URL || 'https://portal.receptionmate.co.uk').replace(/\/$/, '')}/messages?conversation=${id}`;
      void sendEmail({
        to: [emailTo],
        subject,
        text: `${who} on ${platformLabel} at ${garageName} has been assigned to you.\n\nOpen in the portal: ${openUrl}`,
        html: `<p><strong>${who}</strong> on ${platformLabel} at <strong>${garageName}</strong> has been assigned to you.</p><p><a href="${openUrl}">Open in the portal</a></p>`,
      }).catch((err) => console.error('[CONVERSATIONS] Assignment email failed:', err));
    }

    res.json({ success: true, assigneeId: assigneeId ?? null });
  } catch (error) {
    console.error('[CONVERSATIONS] POST /conversations/:id/assign error:', error);
    res.status(500).json({ error: 'Failed to assign conversation' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/conversations/:id/assignable-users
// ---------------------------------------------------------------------------
//
// Return the users who can be assigned this conversation — those with access
// to the conversation's garage. Used to populate the assign dropdown in the
// Messages inbox.

router.get('/conversations/:id/assignable-users', authenticate, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const conversation = await prisma.chatConversation.findUnique({
      where: { id },
      select: { garageId: true },
    });
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    if (!hasGarageAccess(req, conversation.garageId)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Managers + users of this garage. Staff users are excluded — Dan's rule:
    // hello@receptionmate.co.uk stays the ONLY support address; the garage-side
    // inbox is for the garage's own team.
    const users = await prisma.user.findMany({
      where: {
        garageAccessIds: { has: conversation.garageId },
        role: { in: ['USER', 'MANAGER'] },
      },
      select: { id: true, email: true },
      orderBy: { email: 'asc' },
    });

    res.json({ users });
  } catch (error) {
    console.error('[CONVERSATIONS] GET /conversations/:id/assignable-users error:', error);
    res.status(500).json({ error: 'Failed to fetch assignable users' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/conversations/:id/feedback
// ---------------------------------------------------------------------------
//
// Mirror of the call-feedback endpoint (routes/calls.ts). Garage staff or
// ReceptionMate staff rate a conversation up/down; negative ratings ping
// Discord so the Monday audit process picks them up. One row per
// conversation — upsert on re-rating. Kept in the same shape as CallFeedback
// so the weekly audit process uses the same buckets across calls + messages.

router.post('/conversations/:id/feedback', authenticate, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const conversation = await prisma.chatConversation.findUnique({
      where: { id },
      include: { garage: { select: { id: true, name: true } } },
    });
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

    if (!hasGarageAccess(req, conversation.garageId)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const parseResult = chatFeedbackSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({ error: parseResult.error.flatten() });
    }

    const { rating, reasons, notes } = parseResult.data;
    const normalizedReasons = Array.from(
      new Set((reasons ?? []).map((reason) => reason.trim()).filter(Boolean)),
    );
    const sanitizedNotes = notes?.trim() ? notes.trim() : null;

    const feedback = await prisma.chatFeedback.upsert({
      where: { conversationId: id },
      update: { rating, reasons: normalizedReasons, notes: sanitizedNotes },
      create: {
        conversationId: id,
        rating,
        reasons: normalizedReasons,
        notes: sanitizedNotes,
      },
    });

    // Fire the same Discord alert pattern as CallFeedback so ops see negatives
    // in one channel across calls + messages. Email alert is deliberately not
    // wired here yet — sendNegativeFeedbackEmail is call-specific and adding a
    // chat variant is a separate follow-up.
    if (rating === 'down') {
      const platformLabel =
        conversation.platform === 'whatsapp'
          ? 'WhatsApp'
          : conversation.platform === 'facebook'
          ? 'Facebook'
          : conversation.platform === 'instagram'
          ? 'Instagram'
          : conversation.platform === 'livechat'
          ? 'Live chat'
          : conversation.platform === 'widget' || conversation.platform === 'web'
          ? 'Web chat'
          : conversation.platform;

      const fields = [
        { name: 'Branch', value: conversation.garage.name, inline: true },
        { name: 'Platform', value: platformLabel, inline: true },
        { name: 'Conversation ID', value: id, inline: false },
      ];
      if (conversation.customerName) {
        fields.push({ name: 'Customer', value: conversation.customerName, inline: true });
      }
      if (normalizedReasons.length) {
        fields.push({ name: 'Reasons', value: normalizedReasons.join(', '), inline: false });
      }
      if (sanitizedNotes) {
        fields.push({ name: 'Notes', value: sanitizedNotes, inline: false });
      }
      if (req.user?.email) {
        fields.push({ name: 'Flagged by', value: req.user.email, inline: false });
      }

      void sendDiscordNotification({
        title: 'Negative Message Rating',
        description: `A ${platformLabel} conversation at **${conversation.garage.name}** was rated thumbs down.`,
        color: DISCORD_COLORS.error,
        fields,
      }).catch((error) => {
        console.error('[CONVERSATIONS] Discord notification failed:', error);
      });
    }

    res.json({ feedback });
  } catch (error) {
    console.error('[CONVERSATIONS] POST /conversations/:id/feedback error:', error);
    res.status(500).json({ error: 'Failed to save feedback' });
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

  if (platform === 'facebook') {
    if (!platformUserId) return;
    await axios.post(
      `https://graph.facebook.com/v18.0/${connection.pageId}/messages`,
      {
        recipient: { id: platformUserId },
        message: { text: message },
        messaging_type: 'MESSAGE_TAG',
        tag: 'HUMAN_AGENT',
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

  if (platform === 'instagram') {
    if (!platformUserId || !connection.pageId) return;
    await axios.post(
      `https://graph.facebook.com/v18.0/${connection.pageId}/messages`,
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
