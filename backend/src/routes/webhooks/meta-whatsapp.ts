import type { Request, Response } from 'express';
import { Router } from 'express';
import axios from 'axios';
import { prisma } from '../../db.js';
import { getChatAgentResponse } from '../../services/chatAgent.js';
import { findOrCreateCustomer, linkConversationToCustomer } from '../../services/customerService.js';

const router = Router();

// GET /api/webhooks/meta-whatsapp - Webhook verification
router.get('/meta-whatsapp', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN;

  if (mode === 'subscribe' && token === verifyToken) {
    console.log('WhatsApp webhook verified');
    res.status(200).send(challenge);
  } else {
    console.log('WhatsApp webhook verification failed');
    res.sendStatus(403);
  }
});

// POST /api/webhooks/meta-whatsapp - Receive WhatsApp messages
router.post('/meta-whatsapp', async (req: Request, res: Response) => {
  try {
    // Always respond 200 to acknowledge receipt
    res.sendStatus(200);

    const { entry } = req.body;

    if (!entry || !Array.isArray(entry)) {
      console.log('Invalid WhatsApp webhook payload');
      return;
    }

    for (const entryItem of entry) {
      const changes = entryItem.changes;

      if (!changes || !Array.isArray(changes)) {
        continue;
      }

      for (const change of changes) {
        const value = change.value;

        if (!value || !value.messages || !Array.isArray(value.messages)) {
          continue;
        }

        // Extract metadata
        const phoneNumberId = value.metadata?.phone_number_id;

        if (!phoneNumberId) {
          console.log('No phone_number_id in WhatsApp webhook');
          continue;
        }

        // Find garage by phone_number_id
        const connection = await prisma.socialMediaConnection.findFirst({
          where: {
            platform: 'whatsapp',
            whatsappPhoneNumberId: phoneNumberId,
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
          console.log(`No garage found for WhatsApp phone_number_id: ${phoneNumberId}`);
          continue;
        }

        // Process each message
        for (const message of value.messages) {
          const customerPhone = message.from;
          const messageText = message.text?.body;
          const messageType = message.type;

          if (messageType !== 'text' || !messageText) {
            console.log(`Unsupported WhatsApp message type: ${messageType}`);
            continue;
          }

          // Find or create customer
          const contactName = value.contacts?.[0]?.profile?.name || null;
          const customerId = await findOrCreateCustomer({
            garageId: connection.garageId,
            phone: customerPhone,
            whatsappId: customerPhone,
            name: contactName,
          });

          // Find or create conversation
          let conversation = await prisma.chatConversation.findFirst({
            where: {
              garageId: connection.garageId,
              platform: 'whatsapp',
              customerPhone,
            },
          });

          if (!conversation) {
            // Create new conversation
            conversation = await prisma.chatConversation.create({
              data: {
                garageId: connection.garageId,
                platform: 'whatsapp',
                customerPhone,
                platformUserId: customerPhone,
                customerName: contactName,
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
          // Note: We always respond to incoming messages as they're within the 24-hour window
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

            // Send response via WhatsApp
            await axios.post(
              `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
              {
                messaging_product: 'whatsapp',
                to: customerPhone,
                type: 'text',
                text: { body: agentResponse.content },
              },
              {
                headers: {
                  Authorization: `Bearer ${connection.accessToken}`,
                  'Content-Type': 'application/json',
                },
              }
            );

            console.log(`WhatsApp message sent to ${customerPhone}`);
          } else {
            console.log(`Agent paused for conversation ${conversation.id}, no automatic response sent`);
          }
        }
      }
    }
  } catch (error) {
    console.error('WhatsApp webhook error:', error);
    // Don't throw - we already sent 200 response
  }
});

export default router;
