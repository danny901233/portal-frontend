import type { Request, Response } from 'express';
import { Router } from 'express';
import axios from 'axios';
import { prisma } from '../../db.js';
import { routeChatMessage } from '../../services/chatAgentRouter.js';
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

        if (!value) continue;

        // ---------------------------------------------------------------------------
        // Handle delivery status updates for outbound campaign messages
        // ---------------------------------------------------------------------------
        if (value.statuses && Array.isArray(value.statuses)) {
          for (const status of value.statuses) {
            const messageSid = status.id as string | undefined;
            const metaStatus = status.status as string | undefined; // sent, delivered, read, failed
            if (!messageSid || !metaStatus) continue;

            // Map Meta status → our contact status
            let contactStatus: string | null = null;
            let errorReason: string | null = null;

            if (metaStatus === 'delivered') {
              contactStatus = 'delivered';
            } else if (metaStatus === 'read') {
              contactStatus = 'read';
            } else if (metaStatus === 'failed') {
              contactStatus = 'failed';
              const err = status.errors?.[0];
              errorReason = err ? `${err.title} (${err.code})` : 'Delivery failed';
            }

            if (contactStatus) {
              await prisma.outboundContact.updateMany({
                where: { messageSid },
                data: { status: contactStatus, ...(errorReason ? { errorReason } : {}) },
              });
              console.log(`[WhatsApp] Delivery status ${metaStatus} for ${messageSid} → ${contactStatus}`);
            }
          }
        }

        if (!value.messages || !Array.isArray(value.messages)) {
          continue;
        }

        // Extract metadata
        const phoneNumberId = value.metadata?.phone_number_id;

        if (!phoneNumberId) {
          console.log('No phone_number_id in WhatsApp webhook');
          continue;
        }

        // Find garage by phone_number_id
        const include = { garage: { include: { agentConfiguration: true } } };
        let connection = await prisma.socialMediaConnection.findFirst({
          where: { platform: 'whatsapp', whatsappPhoneNumberId: phoneNumberId, isActive: true },
          include,
        });

        if (!connection) {
          // Self-heal: OAuth flow sometimes stores the wrong phone number ID (e.g. WABA ID or
          // first number on account instead of the correct one). If there's exactly one active
          // WhatsApp connection whose stored ID doesn't match, update it automatically.
          const fallback = await prisma.socialMediaConnection.findFirst({
            where: { platform: 'whatsapp', isActive: true },
            include,
          });

          if (!fallback) {
            console.log(`No garage found for WhatsApp phone_number_id: ${phoneNumberId}`);
            continue;
          }

          console.log(`[WhatsApp] Auto-correcting phone_number_id: ${fallback.whatsappPhoneNumberId} → ${phoneNumberId}`);
          await prisma.socialMediaConnection.update({
            where: { id: fallback.id },
            data: { whatsappPhoneNumberId: phoneNumberId },
          });
          connection = { ...fallback, whatsappPhoneNumberId: phoneNumberId };
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

          // Check if this is a reply to an outbound campaign — phone may be stored with or without +
          const phoneVariants = [customerPhone, `+${customerPhone}`, customerPhone.replace(/^\+/, '')];
          const outboundContact = await prisma.outboundContact.findFirst({
            where: {
              garageId: connection.garageId,
              phone: { in: phoneVariants },
              status: { in: ['sent', 'delivered', 'read'] },
            },
            orderBy: { createdAt: 'desc' },
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

          // Inject outbound context the first time a campaign recipient replies
          // (status not yet 'replied' means context hasn't been injected yet)
          if (outboundContact && outboundContact.status !== 'replied') {
            const type = outboundContact.messageType === 'mot' ? 'MOT' : 'service';
            const reg = outboundContact.registration?.toUpperCase() || null;
            const dueDate = outboundContact.motDueDate || outboundContact.serviceDueDate || null;

            const contextParts = [
              `This customer was sent an outbound ${type} reminder campaign and has replied indicating they want to book.`,
              reg ? `Their vehicle registration is ${reg}.` : '',
              dueDate ? `Their ${type} is due on ${dueDate}.` : '',
              `Do NOT ask what you can help with — they want to book their ${type}. Proceed directly to booking, confirming the registration${reg ? ` (${reg})` : ''} with the customer first.`,
            ].filter(Boolean).join(' ');

            await prisma.chatMessage.create({
              data: {
                conversationId: conversation.id,
                role: 'assistant',
                content: `[Context: ${contextParts}]`,
              },
            });

            await prisma.outboundContact.update({
              where: { id: outboundContact.id },
              data: { status: 'replied', conversationId: conversation.id },
            });

            console.log(`[WhatsApp] Outbound reply from ${customerPhone} — context injected, status → replied`);
          }

          // Deduplicate — skip if this Meta message ID was already processed
          const metaMid = message.id as string | undefined;
          if (metaMid) {
            const existing = await prisma.chatMessage.findUnique({ where: { metaMid } });
            if (existing) {
              console.log(`[WhatsApp] Duplicate message ignored: ${metaMid}`);
              continue;
            }
          }

          // Save customer message
          await prisma.chatMessage.create({
            data: {
              conversationId: conversation.id,
              role: 'user',
              content: messageText,
              metaMid: metaMid ?? null,
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
            // Get AI response — router selects the correct agent based on agentScript
            const agentResponse = await routeChatMessage(
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
            try {
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
            } catch (sendError: any) {
              const metaError = sendError?.response?.data;
              console.error(`[WhatsApp] SEND FAILED to ${customerPhone}:`, JSON.stringify(metaError ?? sendError?.message));
            }
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
