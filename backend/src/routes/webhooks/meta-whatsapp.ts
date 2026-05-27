import type { Request, Response } from 'express';
import { Router } from 'express';
import axios from 'axios';
import { prisma } from '../../db.js';
import { routeChatMessage, invalidateSessionCache } from '../../services/chatAgentRouter.js';
import { findOrCreateCustomer, linkConversationToCustomer } from '../../services/customerService.js';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';

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
          let messageText = message.text?.body;
          const messageType = message.type;

          // Reject stale messages (older than 5 minutes) — prevents Meta replay of queued messages
          const msgTimestamp = message.timestamp ? parseInt(message.timestamp, 10) * 1000 : null;
          if (msgTimestamp && Date.now() - msgTimestamp > 5 * 60 * 1000) {
            console.log(`[WhatsApp] Ignoring stale message from ${customerPhone} (age: ${Math.round((Date.now() - msgTimestamp) / 60000)}min)`);
            continue;
          }

          if (messageType !== 'text' && messageType !== 'image') {
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
          const allOutboundContacts = await prisma.outboundContact.findMany({
            where: {
              garageId: connection.garageId,
              phone: { in: phoneVariants },
              status: { in: ['sent', 'delivered', 'read'] },
            },
            orderBy: { createdAt: 'desc' },
          });
          // Prefer the contact the customer most likely read (read > delivered > sent), then most recent
          const statusPriority = ['read', 'delivered', 'sent'];
          const outboundContact = statusPriority.flatMap(s => allOutboundContacts.filter(c => c.status === s))[0] ?? null;
          if (allOutboundContacts.length > 1) {
            console.warn(`[WhatsApp] Multiple active outbound contacts for ${customerPhone} — picked status=${outboundContact?.status} campaignId=${outboundContact?.campaignId}`);
          }

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
            const reg = outboundContact.registration?.toUpperCase() || null;
            const dueDate = outboundContact.motDueDate || outboundContact.serviceDueDate || null;
            const nameParts = (outboundContact.customerName || '').trim().split(/\s+/);

            // Reconstruct the original outbound message so it appears in the conversation view
            let outboundMessageText: string | null = null;
            try {
              const campaign = await prisma.outboundCampaign.findUnique({ where: { id: outboundContact.campaignId } });
              if (campaign?.messageTemplateId) {
                const tmpl = await prisma.messageTemplate.findUnique({ where: { id: campaign.messageTemplateId } });
                if (tmpl) {
                  const varMap = (campaign.variableMapping as Record<string, string>) || {};
                  const agentCfg = await prisma.agentConfiguration.findUnique({
                    where: { garageId: connection.garageId },
                    select: { branchName: true },
                  });
                  const contactFields: Record<string, string> = {
                    customer_name: nameParts[0] || outboundContact.customerName,
                    full_name: outboundContact.customerName,
                    registration: reg || '',
                    mot_due_date: outboundContact.motDueDate || '',
                    service_due_date: outboundContact.serviceDueDate || '',
                    garage_name: agentCfg?.branchName || 'our garage',
                  };
                  let body = tmpl.bodyText;
                  for (const [varNum, field] of Object.entries(varMap)) {
                    body = body.replace(new RegExp(`\\{\\{${varNum}\\}\\}`, 'g'), contactFields[field] || '');
                  }
                  outboundMessageText = body;
                }
              }
            } catch (e) {
              console.error('[WhatsApp] Failed to reconstruct outbound message:', e);
            }

            // Save the outbound message as a regular assistant bubble (backdated to when it was sent)
            if (outboundMessageText) {
              await prisma.chatMessage.create({
                data: {
                  conversationId: conversation.id,
                  role: 'assistant',
                  content: outboundMessageText,
                  createdAt: outboundContact.createdAt,
                },
              });
            }

            // Seed sessionState so the agent knows the registration without asking.
            // Also reset booking fields so old session state from a previous flow
            // (e.g. step=NEED_CONTACT from a different vehicle's conversation) doesn't
            // cause the agent to skip the booking flow and ask for phone instead.
            await prisma.$executeRawUnsafe(
              `UPDATE "ChatConversation" SET "sessionState" = COALESCE("sessionState", '{}'::jsonb) || $1::jsonb WHERE id = $2`,
              JSON.stringify({
                customerNameFirst: nameParts[0] || '',
                customerNameLast: nameParts.slice(1).join(' ') || '',
                ...(reg && { outboundRegistration: reg }),
                outboundServiceType: outboundContact.messageType || 'mot',
                ...(dueDate && { outboundDueDate: dueDate }),
                // Vehicle is already known from the CSV — trust it, skip VRN confirmation.
                // Start at need_service so the agent greets + upsells, then goes straight
                // to timeslot selection. GH session is initialised later by handleSelectService.
                step: 'need_service',
                vrn: reg || null,
                vrnConfirmed: !!(reg),
                sessionId: null,
                vehicleMake: null,
                vehicleModel: null,
                servicesAvailable: null,
                serviceSelectedName: null,
                serviceSelectedId: null,
                servicePrice: null,
                timeslotsAvailable: null,
                bookingDate: null,
                bookingTime: null,
              }),
              conversation.id,
            );

            const seedResult = await prisma.$queryRawUnsafe<Array<{ sessionState: any }>>(
              `SELECT "sessionState" FROM "ChatConversation" WHERE id = $1`,
              conversation.id
            );
            console.log(`[WhatsApp] Seed verify — step: ${seedResult[0]?.sessionState?.step}, vrn: ${seedResult[0]?.sessionState?.vrn}, convId: ${conversation.id}`);

            await prisma.outboundContact.update({
              where: { id: outboundContact.id },
              data: { status: 'replied', conversationId: conversation.id },
            });

            // Invalidate the in-memory session cache so getChatAgentResponse
            // picks up the freshly-seeded outbound state from the DB instead of
            // using a stale cached session from a previous conversation.
            invalidateSessionCache(conversation.id);

            console.log(`[WhatsApp] Outbound reply from ${customerPhone} — message saved, session seeded with reg=${reg}`);
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

          // Handle image messages — download from Graph API and upload to S3
          let mediaUrl: string | null = null;
          let mediaType: string | null = null;
          if (messageType === 'image') {
            try {
              const imageInfo = message.image;
              const mediaId = imageInfo?.id;
              const caption = imageInfo?.caption || '';
              if (mediaId) {
                const mediaResp = await axios.get(`https://graph.facebook.com/v21.0/${mediaId}`, {
                  headers: { Authorization: `Bearer ${connection.accessToken}` },
                });
                const downloadUrl = mediaResp.data.url;
                const mimeType = mediaResp.data.mime_type || 'image/jpeg';

                const imageResp = await axios.get(downloadUrl, {
                  headers: { Authorization: `Bearer ${connection.accessToken}` },
                  responseType: 'arraybuffer',
                });

                const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
                const s3Key = `chat-media/${connection.garageId}/${conversation.id}/${randomUUID()}.${ext}`;
                const awsAccessKey = process.env.S3_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
                const awsSecretKey = process.env.S3_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;
                const awsRegion = process.env.S3_REGION || process.env.AWS_REGION || 'eu-west-2';
                const s3Bucket = process.env.S3_MEDIA_BUCKET || process.env.S3_BUCKET || 'receptionmate-recordings';

                if (awsAccessKey && awsSecretKey) {
                  const s3 = new S3Client({
                    region: awsRegion,
                    credentials: { accessKeyId: awsAccessKey, secretAccessKey: awsSecretKey },
                  });
                  await s3.send(new PutObjectCommand({
                    Bucket: s3Bucket,
                    Key: s3Key,
                    Body: Buffer.from(imageResp.data),
                    ContentType: mimeType,
                  }));
                  mediaUrl = `https://${s3Bucket}.s3.${awsRegion}.amazonaws.com/${s3Key}`;
                  mediaType = mimeType;
                  console.log(`[WhatsApp] Image uploaded to S3: ${s3Key}`);
                }
                if (caption) {
                  messageText = caption;
                }
              }
            } catch (imgErr) {
              console.error('[WhatsApp] Failed to download/upload image:', imgErr);
            }
          }

          // Save customer message
          await prisma.chatMessage.create({
            data: {
              conversationId: conversation.id,
              role: 'user',
              content: messageText || (mediaUrl ? '[Image]' : ''),
              mediaUrl,
              mediaType,
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

          // Only send agent response if agent is not paused and there's text to process
          // Note: We always respond to incoming messages as they're within the 24-hour window
          const agentText = messageText || (mediaUrl ? '[Customer sent an image]' : null);
          if (!isAgentPaused && agentText) {
            // Get AI response — router selects the correct agent based on agentScript
            const agentResponse = await routeChatMessage(
              connection.garageId,
              agentText,
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
                `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`,
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
