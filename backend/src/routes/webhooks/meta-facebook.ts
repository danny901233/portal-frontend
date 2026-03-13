import type { Request, Response } from 'express';
import { Router } from 'express';
import axios from 'axios';
import { prisma } from '../../db.js';
import { routeChatMessage } from '../../services/chatAgentRouter.js';
import { findOrCreateCustomer } from '../../services/customerService.js';

const router = Router();

// GET /api/webhooks/meta-facebook - Webhook verification (handles both Facebook and Instagram)
router.get('/meta-facebook', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN;

  if (mode === 'subscribe' && token === verifyToken) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// POST /api/webhooks/meta-facebook - Receive Facebook AND Instagram messages
// Meta sends both Facebook (object='page') and Instagram (object='instagram') here.
router.post('/meta-facebook', async (req: Request, res: Response) => {
  try {
    res.sendStatus(200);

    const { object, entry } = req.body;

    if (!entry || !Array.isArray(entry)) return;

    const isInstagram = object === 'instagram';

    for (const entryItem of entry) {
      const messaging = entryItem.messaging;
      if (!messaging || !Array.isArray(messaging)) continue;

      for (const event of messaging) {
        if (!event.message || event.message.is_echo) continue;

        const senderId = event.sender.id;
        const messageText = event.message.text;
        if (!messageText) continue;

        // entry[].id is Instagram Business Account ID for IG, Facebook Page ID for FB
        const connection = isInstagram
          ? await prisma.socialMediaConnection.findFirst({
              where: { platform: 'instagram', instagramAccountId: entryItem.id, isActive: true },
              include: { garage: { include: { agentConfiguration: true } } },
            })
          : await prisma.socialMediaConnection.findFirst({
              where: { platform: 'facebook', pageId: entryItem.id, isActive: true },
              include: { garage: { include: { agentConfiguration: true } } },
            });

        if (!connection) {
          console.log(`[WEBHOOK] No connection found for ${isInstagram ? 'instagram' : 'facebook'} id: ${entryItem.id}`);
          continue;
        }

        const platform = isInstagram ? 'instagram' : 'facebook';

        // Find or create customer
        const customerId = await findOrCreateCustomer({
          garageId: connection.garageId,
          ...(isInstagram ? { instagramUserId: senderId } : { facebookUserId: senderId }),
        });

        // Find or create conversation
        let conversation = await prisma.chatConversation.findFirst({
          where: { garageId: connection.garageId, platform, platformUserId: senderId },
        });

        if (!conversation) {
          conversation = await prisma.chatConversation.create({
            data: {
              garageId: connection.garageId,
              platform,
              platformUserId: senderId,
              customerId,
              status: 'active',
              unreadCount: 1,
              lastMessageAt: new Date(),
            },
          });
        } else {
          await prisma.chatConversation.update({
            where: { id: conversation.id },
            data: { customerId, unreadCount: { increment: 1 }, lastMessageAt: new Date(), status: 'active' },
          });
        }

        // Deduplicate — skip if this Meta message ID was already processed
        const metaMid = event.message.mid as string | undefined;
        if (metaMid) {
          const existing = await prisma.chatMessage.findUnique({ where: { metaMid } });
          if (existing) {
            console.log(`[WEBHOOK] Duplicate message ignored: ${metaMid}`);
            continue;
          }
        }

        // Save customer message
        await prisma.chatMessage.create({
          data: { conversationId: conversation.id, role: 'user', content: messageText, metaMid: metaMid ?? null },
        });

        // Auto-resume agent if pause has expired
        let isAgentPaused = conversation.agentPaused;
        if (conversation.agentPaused && conversation.agentPausedUntil && new Date() > conversation.agentPausedUntil) {
          await prisma.chatConversation.update({
            where: { id: conversation.id },
            data: { agentPaused: false, agentPausedUntil: null },
          });
          isAgentPaused = false;
        }

        if (isAgentPaused) {
          console.log(`[WEBHOOK] Agent paused for conversation ${conversation.id}`);
          continue;
        }

        // Get AI response
        const agentResponse = await routeChatMessage(connection.garageId, messageText, conversation.id);

        // Save AI response
        await prisma.chatMessage.create({
          data: { conversationId: conversation.id, role: 'assistant', content: agentResponse.content },
        });

        // Send reply — Instagram requires /{pageId}/messages, Facebook uses /me/messages
        const replyUrl = isInstagram
          ? `https://graph.facebook.com/v18.0/${connection.pageId}/messages`
          : 'https://graph.facebook.com/v18.0/me/messages';

        await axios.post(
          replyUrl,
          { recipient: { id: senderId }, message: { text: agentResponse.content } },
          { headers: { Authorization: `Bearer ${connection.accessToken}`, 'Content-Type': 'application/json' } }
        );

        console.log(`[WEBHOOK] ${platform} reply sent to ${senderId}`);
      }
    }
  } catch (error) {
    console.error('[WEBHOOK] meta-facebook error:', error);
  }
});

export default router;
