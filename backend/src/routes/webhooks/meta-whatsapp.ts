import type { Request, Response } from 'express';
import { Router } from 'express';
import axios from 'axios';
import { prisma } from '../../db.js';
import { notifyMessaging } from '../../services/messagingNotifications.js';
import { routeChatMessage, invalidateSessionCache } from '../../services/chatAgentRouter.js';
import { scheduleHumanReply } from '../../services/chatDelay.js';
import { sendEmail } from '../../utils/email.js';
import { findOrCreateCustomer, linkConversationToCustomer } from '../../services/customerService.js';
import { isWhatsappAdmin, handleAdminOpsMessage } from '../../services/whatsappOps.js';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';

const router = Router();

// Connect free-trial conversation cap. After this many WhatsApp conversations on the free month,
// the trial ends (accessRestricted=true → card paywall) and the agent pauses until they add a card.
const CONNECT_TRIAL_CONVO_CAP = Number(process.env.CONNECT_TRIAL_CONVO_CAP ?? 500);

async function notifyConnectCapReached(garageId: string): Promise<void> {
  const g = await prisma.garage.findUnique({
    where: { id: garageId },
    select: { name: true, business: { select: { contactEmail: true } } },
  });
  let email = g?.business?.contactEmail || null;
  if (!email) {
    const u = await prisma.user.findFirst({ where: { garageAccessIds: { has: garageId } }, select: { email: true } });
    email = u?.email || null;
  }
  if (!email) return;
  const portal = process.env.PORTAL_URL || 'https://portal.receptionmate.co.uk';
  await sendEmail({
    to: [email],
    subject: `You’ve used your ${CONNECT_TRIAL_CONVO_CAP} free Connect conversations`,
    text: `You've used your ${CONNECT_TRIAL_CONVO_CAP} free Connect conversations, so your AI has paused. Add a card to continue: ${portal}/dashboard`,
    html: `<div style="font-family:Inter,system-ui,sans-serif;max-width:560px;margin:0 auto;color:#0f172a;"><h2 style="color:#3426cf;">Your ${CONNECT_TRIAL_CONVO_CAP} free conversations are used up</h2><p>Hi ${g?.name || 'there'},</p><p>Your ReceptionMate Connect free month included ${CONNECT_TRIAL_CONVO_CAP} WhatsApp conversations, and you've now used them — so your AI has paused. Add a card to switch it back on: £250 + VAT a month, cancel anytime.</p><p style="text-align:center;margin:28px 0;"><a href="${portal}/dashboard" style="display:inline-block;background:#3426cf;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;">Add my card</a></p><p style="color:#64748b;font-size:13px;">— The ReceptionMate team</p></div>`,
  }).catch((e) => console.error('[CONNECT_CAP] email failed', e));
}

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
          // No active connection matches this phone number ID — ignore the message.
          // NOTE: this used to "self-heal" by hijacking the first active WhatsApp connection
          // and overwriting its whatsappPhoneNumberId to the incoming one. That was safe with a
          // single connection, but with multiple it CORRUPTS a random garage's number — it
          // scrambled MMH / ops / ReceptionMate on 2026-07-02. Never auto-rewrite; just skip.
          console.log(`No active WhatsApp connection for phone_number_id: ${phoneNumberId} — ignoring.`);
          continue;
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

          // ── OPS ASSISTANT (internal) ─────────────────────────────────────────
          // A message from an allow-listed ReceptionMate admin number, sent TO the
          // dedicated ops/diagnostics line, is handled by the internal diagnostics agent,
          // NOT the customer receptionist. Scoped to the ops number so that an admin can
          // still message a *customer* garage's WhatsApp (e.g. to test it) and reach that
          // garage's agent. Isolated: guarded + try/catch + `continue`; failures swallowed.
          const OPS_PHONE_ID = process.env.OPS_WHATSAPP_PHONE_NUMBER_ID || '565650793296121';
          if (messageText && phoneNumberId === OPS_PHONE_ID && isWhatsappAdmin(customerPhone)) {
            try {
              await handleAdminOpsMessage({
                from: customerPhone,
                text: messageText,
                phoneNumberId,
                accessToken: connection.accessToken,
              });
            } catch (err) {
              console.error('[WhatsApp Ops] handler error:', err);
            }
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
            const agentCfg = await prisma.agentConfiguration.findUnique({
              where: { garageId: connection.garageId },
              select: { branchName: true, agentScript: true },
            });
            const agentScript = agentCfg?.agentScript || null;

            // Reconstruct the original outbound message so it appears in the conversation view
            let outboundMessageText: string | null = null;
            try {
              const campaign = await prisma.outboundCampaign.findUnique({ where: { id: outboundContact.campaignId } });
              if (campaign?.messageTemplateId) {
                const tmpl = await prisma.messageTemplate.findUnique({ where: { id: campaign.messageTemplateId } });
                if (tmpl) {
                  const varMap = (campaign.variableMapping as Record<string, string>) || {};
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

            // Seed sessionState in the SHAPE the destination chat agent expects.
            // Bookar and the GH-family agents (chatAgentV2) read completely different
            // keys from sessionState (vrm vs vrn, customerName vs customerNameFirst/Last).
            // Without this branch, replies to outbound reminders on a bookar-agent garage
            // land as if the caller never got the reminder, and the agent asks for the reg
            // from scratch.
            let seedPayload: Record<string, unknown>;
            if (agentScript === 'bookar-agent') {
              // Bookar shape (see BookarSessionState in services/chatAgentBookar.ts).
              // We seed only what the reminder actually told us. Bookar's bk_lookup_vehicle
              // will fill in make/model on the first tool call; leaving vehicle undefined
              // lets it do that.
              //
              // customerPhone is deliberately NOT seeded from outboundContact.phone —
              // Bookar's booking API rejects phones >11 digits (no E.164/international
              // support). outboundContact.phone can be any format (E.164 with '+',
              // country-code-prefixed, UK 07... etc). Leaving it empty forces the agent
              // to ask + validate via bk_save_customer_details before bk_create_booking,
              // which is the only path guaranteed to yield a phone Bookar accepts.
              seedPayload = {
                ...(reg && { vrm: reg }),
                customerName: outboundContact.customerName || '',
                customerEmail: '',
                selectedServiceIds: [],
                bookingConfirmed: false,
              };
            } else {
              // GH-family agents (receptionmate-agent-v3, Assist-agent, GarageHive-agent,
              // tyresoft-agent). Keep the original GH-shaped seed — chatAgentV2 reads
              // step=need_service + vrn/vrnConfirmed to skip the VRN prompt.
              seedPayload = {
                customerNameFirst: nameParts[0] || '',
                customerNameLast: nameParts.slice(1).join(' ') || '',
                ...(reg && { outboundRegistration: reg }),
                outboundServiceType: outboundContact.messageType || 'mot',
                ...(dueDate && { outboundDueDate: dueDate }),
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
              };
            }

            await prisma.$executeRawUnsafe(
              `UPDATE "ChatConversation" SET "sessionState" = COALESCE("sessionState", '{}'::jsonb) || $1::jsonb WHERE id = $2`,
              JSON.stringify(seedPayload),
              conversation.id,
            );

            const seedResult = await prisma.$queryRawUnsafe<Array<{ sessionState: any }>>(
              `SELECT "sessionState" FROM "ChatConversation" WHERE id = $1`,
              conversation.id
            );
            const s = seedResult[0]?.sessionState || {};
            console.log(
              `[WhatsApp] Seed verify — agent=${agentScript || 'unknown'} ` +
              `vrm=${s.vrm ?? '-'} vrn=${s.vrn ?? '-'} step=${s.step ?? '-'} ` +
              `customerName=${s.customerName ?? '-'} convId=${conversation.id}`
            );

            await prisma.outboundContact.update({
              where: { id: outboundContact.id },
              data: { status: 'replied', conversationId: conversation.id },
            });

            // Invalidate the in-memory session cache so getChatAgentResponse
            // picks up the freshly-seeded outbound state from the DB instead of
            // using a stale cached session from a previous conversation.
            invalidateSessionCache(conversation.id);

            console.log(`[WhatsApp] Outbound reply from ${customerPhone} — message saved, session seeded (agent=${agentScript || 'unknown'}) with reg=${reg}`);
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

          // Messaging notifications (scope 'all') — alert the garage about the new
          // inbound message. No-op unless enabled. Fire-and-forget.
          void notifyMessaging({
            conversationId: conversation.id,
            event: 'inbound',
            preview: messageText || (mediaUrl ? '[Image]' : ''),
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

          // Connect free-trial cap: once a garage on the free month exceeds CONNECT_TRIAL_CONVO_CAP
          // conversations, end the trial (accessRestricted → card paywall) and pause the agent. Only
          // Connect garages still on the free month (in trial, no card) are metered.
          let trialCapReached = false;
          const gg = connection.garage;
          if (gg?.accessRestricted) {
            trialCapReached = true; // already locked (cap hit earlier, or the time-based trial ended)
          } else if (gg?.hasMessagingAccess && gg?.trialEndDate && new Date(gg.trialEndDate).getTime() > Date.now() && !gg?.stripeSubscriptionId) {
            const convoCount = await prisma.chatConversation.count({ where: { garageId: connection.garageId } });
            if (convoCount > CONNECT_TRIAL_CONVO_CAP) {
              trialCapReached = true;
              await prisma.garage.update({ where: { id: connection.garageId }, data: { accessRestricted: true } })
                .catch((e) => console.error('[CONNECT_CAP] lock failed', e));
              void notifyConnectCapReached(connection.garageId);
              console.log(`[CONNECT_CAP] garage ${connection.garageId} exceeded ${CONNECT_TRIAL_CONVO_CAP} conversations — trial ended + locked`);
            }
          }

          if (!isAgentPaused && agentText && !trialCapReached) {
            // Human-like delayed reply: acks the webhook instantly, shows "seen"/"typing…",
            // then sends after a weighted-random delay — batching any messages that arrive
            // during the wait into one reply. (Kill switch: env CHAT_HUMAN_DELAY=off.)
            scheduleHumanReply({
              garageId: connection.garageId,
              conversationId: conversation.id,
              phoneNumberId,
              customerPhone,
              accessToken: connection.accessToken,
              agentText,
              metaMid,
            });
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
