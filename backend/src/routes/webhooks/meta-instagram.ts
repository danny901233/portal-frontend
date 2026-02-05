import type { Request, Response } from 'express';
import { Router } from 'express';
import axios from 'axios';
import { prisma } from '../../db.js';
import { getChatAgentResponse } from '../../services/chatAgent.js';
import { findOrCreateCustomer, linkConversationToCustomer } from '../../services/customerService.js';

const router = Router();

// GET /api/webhooks/meta-instagram - Webhook verification
router.get('/meta-instagram', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN;

  if (mode === 'subscribe' && token === verifyToken) {
    console.log('Instagram webhook verified');
    res.status(200).send(challenge);
  } else {
    console.log('Instagram webhook verification failed');
    res.sendStatus(403);
  }
});

// POST /api/webhooks/meta-instagram - Receive Instagram messages
router.post('/meta-instagram', async (req: Request, res: Response) => {
  try {
    // Always respond 200 to acknowledge receipt
    res.sendStatus(200);

    const { entry } = req.body;

    if (!entry || !Array.isArray(entry)) {
      console.log('Invalid Instagram webhook payload');
      return;
    }

    for (const entryItem of entry) {
      const messaging = entryItem.messaging;

      if (!messaging || !Array.isArray(messaging)) {
        continue;
      }

      for (const event of messaging) {
        // Only process messages (not delivery confirmations, reads, etc.)
        if (!event.message || event.message.is_echo) {
          continue;
        }

        const instagramAccountId = entryItem.id;
        const senderId = event.sender.id;
        const messageText = event.message.text;

        if (!messageText) {
          console.log('Instagram message has no text');
          continue;
        }

        // Find garage by instagramAccountId
        const connection = await prisma.socialMediaConnection.findFirst({
          where: {
            platform: 'instagram',
            instagramAccountId,
            isActive: true,
          },
          include: {
            garage: {
              include: {
                agentConfiguration: true,
              },
            },
          },
        });

        if (!connection) {
          console.log(`No garage found for Instagram accountId: ${instagramAccountId}`);
          continue;
        }

        // Find or create customer
        const customerId = await findOrCreateCustomer({
          garageId: connection.garageId,
          instagramUserId: senderId,
        });

        // Find or create conversation
        let conversation = await prisma.chatConversation.findFirst({
          where: {
            garageId: connection.garageId,
            platform: 'instagram',
            platformUserId: senderId,
          },
        });

        if (!conversation) {
          // Create new conversation
          conversation = await prisma.chatConversation.create({
            data: {
              garageId: connection.garageId,
              platform: 'instagram',
              platformUserId: senderId,
              customerId,
              status: 'active',
              unreadCount: 1,
              lastMessageAt: new Date(),
            },
          });
        } else {
          // Update existing conversation
          await prisma.chatConversation.update({
            where: { id: conversation.id },
            data: {
              customerId,
              unreadCount: { increment: 1 },
              lastMessageAt: new Date(),
              status: 'active',
            },
          });
        }

        // Save customer message
        await prisma.chatMessage.create({
          data: {
            conversationId: conversation.id,
            role: 'user',
            content: messageText,
          },
        });

        // Check if agent pause has expired and auto-resume
        let isAgentPaused = conversation.agentPaused;
        if (conversation.agentPaused && conversation.agentPausedUntil) {
          if (new Date() > conversation.agentPausedUntil) {
            // Pause has expired, resume agent
            await prisma.chatConversation.update({
              where: { id: conversation.id },
              data: { agentPaused: false, agentPausedUntil: null },
            });
            isAgentPaused = false;
            console.log(`Agent auto-resumed for conversation ${conversation.id}`);
          }
        }

        // Only send agent response if agent is not paused
        if (!isAgentPaused) {
          // Get AI response
          const agentResponse = await getChatAgentResponse(
            connection.garageId,
            messageText,
            conversation.id
          );

          // Save AI response
          await prisma.chatMessage.create({
            data: {
              conversationId: conversation.id,
              role: 'assistant',
              content: agentResponse.content,
            },
          });

          // Send response via Instagram Messaging API
          await axios.post(
            'https://graph.facebook.com/v18.0/me/messages',
            {
              recipient: { id: senderId },
              message: { text: agentResponse.content },
            },
            {
              headers: {
                Authorization: `Bearer ${connection.accessToken}`,
                'Content-Type': 'application/json',
              },
            }
          );

          console.log(`Instagram message sent to ${senderId}`);
        } else {
          console.log(`Agent paused for conversation ${conversation.id}, no automatic response sent`);
        }
      }
    }
  } catch (error) {
    console.error('Instagram webhook error:', error);
    // Don't throw - we already sent 200 response
  }
});

export default router;
