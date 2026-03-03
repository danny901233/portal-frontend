import type { Request, Response } from 'express';
import { Router } from 'express';
import axios from 'axios';
import { prisma } from '../../db.js';
import { routeChatMessage } from '../../services/chatAgentRouter.js';

const router = Router();

const LIVECHAT_API = 'https://api.livechatinc.com/v3.5/agent/action';

/**
 * Send a message back to the LiveChat chat.
 */
async function sendLiveChatMessage(
  chatId: string,
  text: string,
  accessToken: string,
  entityId: string
): Promise<void> {
  await axios.post(
    `${LIVECHAT_API}/send_event`,
    {
      chat_id: chatId,
      event: {
        type: 'message',
        text,
        visibility: 'all',
      },
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'X-Region': 'dal',
        'Content-Type': 'application/json',
        'Account-Id': entityId,
      },
      timeout: 15000,
    }
  );
}

// GET /api/webhooks/livechat - Webhook verification (not required for LiveChat but useful for testing)
router.get('/livechat', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', message: 'LiveChat webhook endpoint active' });
});

// POST /api/webhooks/livechat - Receive LiveChat message events
router.post('/livechat', async (req: Request, res: Response) => {
  try {
    // Always acknowledge immediately
    res.sendStatus(200);

    const body = req.body;

    // Only handle incoming_message or incoming_chat actions
    const action = body?.action;
    if (action !== 'incoming_message' && action !== 'incoming_chat') {
      return;
    }

    const licenseId = String(body?.license_id || '');
    const chatId = body?.chat_id || body?.chat?.id;
    const eventText = body?.event?.text || body?.chat?.events?.[0]?.text;
    const authorType = body?.event?.author_type || body?.chat?.events?.[0]?.author_type;

    // Ignore messages sent by agents (avoid self-reply loop)
    if (authorType === 'agent') {
      return;
    }

    if (!licenseId || !chatId || !eventText) {
      console.log('[LIVECHAT] Missing required fields:', { licenseId, chatId, eventText });
      return;
    }

    // Look up garage by licenseId stored in whatsappPhoneNumberId
    const connection = await prisma.socialMediaConnection.findFirst({
      where: {
        platform: 'livechat',
        whatsappPhoneNumberId: licenseId,
        isActive: true,
      },
    });

    if (!connection) {
      console.log(`[LIVECHAT] No garage found for licenseId: ${licenseId}`);
      return;
    }

    const garageId = connection.garageId;
    const entityId = connection.pageId || '';

    // Find or create conversation keyed on chatId
    let conversation = await prisma.chatConversation.findFirst({
      where: {
        garageId,
        platform: 'livechat',
        platformUserId: chatId,
      },
    });

    if (!conversation) {
      conversation = await prisma.chatConversation.create({
        data: {
          garageId,
          platform: 'livechat',
          platformUserId: chatId,
          status: 'active',
          unreadCount: 1,
          lastMessageAt: new Date(),
        },
      });
    } else {
      await prisma.chatConversation.update({
        where: { id: conversation.id },
        data: {
          unreadCount: { increment: 1 },
          lastMessageAt: new Date(),
          status: 'active',
        },
      });
    }

    // Check agent pause
    let isAgentPaused = conversation.agentPaused;
    if (conversation.agentPaused && conversation.agentPausedUntil) {
      if (new Date() > conversation.agentPausedUntil) {
        await prisma.chatConversation.update({
          where: { id: conversation.id },
          data: { agentPaused: false, agentPausedUntil: null },
        });
        isAgentPaused = false;
      }
    }

    // Save customer message
    await prisma.chatMessage.create({
      data: {
        conversationId: conversation.id,
        role: 'user',
        content: eventText,
      },
    });

    if (isAgentPaused) {
      console.log(`[LIVECHAT] Agent paused for conversation ${conversation.id}`);
      return;
    }

    // Get AI response
    const agentResponse = await routeChatMessage(garageId, eventText, conversation.id);

    // Save AI response
    await prisma.chatMessage.create({
      data: {
        conversationId: conversation.id,
        role: 'assistant',
        content: agentResponse.content,
      },
    });

    // Send response back to LiveChat
    await sendLiveChatMessage(chatId, agentResponse.content, connection.accessToken, entityId);

    console.log(`[LIVECHAT] Responded to chat ${chatId} for garage ${garageId}`);
  } catch (error) {
    console.error('[LIVECHAT] Webhook error:', error);
    // 200 already sent — don't rethrow
  }
});

export default router;
