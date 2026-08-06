import type { Request, Response } from 'express';
import { Router } from 'express';
import axios from 'axios';
import { prisma } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { routeChatMessage } from '../services/chatAgentRouter.js';

const router = Router();

/** Normalise phone to E.164 format for Twilio and matching */
function normalisePhone(raw: string): string {
  // Strip whatsapp: prefix and all whitespace/dashes/parens
  let n = raw.replace(/^whatsapp:/i, '').replace(/[\s\-().]/g, '');
  // 07xxxxxxxxx → +447xxxxxxxxx
  if (/^07\d{9}$/.test(n)) n = `+44${n.slice(1)}`;
  // 447xxxxxxxxx (no +) → +447xxxxxxxxx
  else if (/^44\d{10}$/.test(n)) n = `+${n}`;
  // Already E.164
  return n;
}

/** Build the outbound message text for a contact */
function buildMessage(
  customerName: string,
  messageType: string,
  dueDate: string,
  registration: string | null | undefined,
  garageName: string,
): string {
  const firstName = customerName.trim().split(/\s+/)[0];
  const reg = registration ? ` for your ${registration.toUpperCase()}` : '';

  if (messageType === 'service') {
    return `Hi ${firstName}, this is Leah from ${garageName}. Your${reg} is due a service on ${dueDate}. Would you like to book that in with me? Reply STOP to opt out.`;
  }
  return `Hi ${firstName}, this is Leah from ${garageName}. Your${reg} MOT is due on ${dueDate}. Would you like to book that in with me? Reply STOP to opt out.`;
}

// ---------------------------------------------------------------------------
// POST /api/outbound/campaigns — create campaign + bulk import contacts
// ---------------------------------------------------------------------------
router.post('/outbound/campaigns', authenticate, async (req: Request, res: Response) => {
  try {
    const { garageId, name, channel, contacts, messageTemplateId, variableMapping } = req.body as {
      garageId: string;
      name: string;
      channel: 'sms' | 'whatsapp';
      contacts: Array<{
        customerName: string;
        phone: string;
        registration?: string;
        motDueDate?: string;
        serviceDueDate?: string;
      }>;
      messageTemplateId?: string;
      variableMapping?: Record<string, string>;
    };

    if (!garageId || !name || !contacts || !Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Derive messageType per contact and normalise phones
    const normalised = contacts.map((c) => ({
      garageId,
      customerName: c.customerName?.trim() || 'Customer',
      phone: normalisePhone(c.phone || ''),
      registration: c.registration?.trim() || null,
      motDueDate: c.motDueDate?.trim() || null,
      serviceDueDate: c.serviceDueDate?.trim() || null,
      messageType: c.motDueDate?.trim() ? 'mot' : 'service',
    }));

    // Cross-campaign DNC: mark opted-out phones at import time
    const phones = normalised.map((c) => c.phone).filter(Boolean);
    const optedOut = await prisma.outboundContact.findMany({
      where: { garageId, phone: { in: phones }, status: 'opted_out' },
      select: { phone: true },
    });
    const dncPhones = new Set(optedOut.map((c) => c.phone));

    const contactData = normalised.map((c) => ({
      ...c,
      status: dncPhones.has(c.phone) ? 'opted_out' : 'pending',
    }));

    const campaign = await prisma.outboundCampaign.create({
      data: {
        garageId,
        name,
        channel: channel || 'sms',
        totalContacts: contactData.length,
        messageTemplateId: messageTemplateId || undefined,
        variableMapping: variableMapping || undefined,
        contacts: {
          create: contactData,
        },
      },
      include: { contacts: true },
    });

    res.json({ success: true, campaign });
  } catch (error) {
    console.error('[OUTBOUND] Create campaign error:', error);
    res.status(500).json({ error: 'Failed to create campaign' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/outbound/campaigns?garageId=... — list campaigns
// ---------------------------------------------------------------------------
router.get('/outbound/campaigns', authenticate, async (req: Request, res: Response) => {
  try {
    const { garageId } = req.query as { garageId: string };

    if (!garageId) {
      return res.status(400).json({ error: 'garageId required' });
    }

    const campaigns = await prisma.outboundCampaign.findMany({
      where: { garageId },
      include: {
        _count: { select: { contacts: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ campaigns });
  } catch (error) {
    console.error('[OUTBOUND] List campaigns error:', error);
    res.status(500).json({ error: 'Failed to list campaigns' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/outbound/campaigns/:id — get campaign with contacts
// ---------------------------------------------------------------------------
router.get('/outbound/campaigns/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const campaign = await prisma.outboundCampaign.findUnique({
      where: { id: req.params.id },
      include: { contacts: { orderBy: { createdAt: 'asc' } } },
    });

    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    res.json({ campaign });
  } catch (error) {
    console.error('[OUTBOUND] Get campaign error:', error);
    res.status(500).json({ error: 'Failed to get campaign' });
  }
});

// ---------------------------------------------------------------------------
// Shared batch-send logic — used by both the route handler and the cron job
// ---------------------------------------------------------------------------
async function sendCampaignBatch(campaignId: string): Promise<{ sent: number; remaining: number; status: string }> {
  const campaign = await prisma.outboundCampaign.findUnique({
    where: { id: campaignId },
    include: { contacts: { where: { status: 'pending' } } },
  });

  if (!campaign || campaign.contacts.length === 0) {
    return { sent: 0, remaining: 0, status: campaign?.status || 'failed' };
  }

  const [agentConfig, waConnection, template] = await Promise.all([
    prisma.agentConfiguration.findUnique({
      where: { garageId: campaign.garageId },
      select: { branchName: true },
    }),
    prisma.socialMediaConnection.findFirst({
      where: { garageId: campaign.garageId, platform: 'whatsapp', isActive: true },
      select: { whatsappPhoneNumberId: true, accessToken: true },
    }),
    campaign.messageTemplateId
      ? prisma.messageTemplate.findUnique({
          where: { id: campaign.messageTemplateId },
          select: { name: true, language: true, bodyText: true },
        })
      : Promise.resolve(null),
  ]);
  const garageName = agentConfig?.branchName || 'our garage';
  const variableMapping = (campaign.variableMapping as Record<string, string> | null) || {};

  if (!waConnection?.whatsappPhoneNumberId || waConnection.whatsappPhoneNumberId === 'pending_setup') {
    console.error(`[OUTBOUND] No WhatsApp sender configured for garage ${campaign.garageId}`);
    return { sent: 0, remaining: campaign.contacts.length, status: 'failed' };
  }

  if (campaign.channel === 'whatsapp' && !template) {
    console.error(`[OUTBOUND] WhatsApp campaign ${campaign.id} has no template`);
    return { sent: 0, remaining: campaign.contacts.length, status: 'failed' };
  }

  const { whatsappPhoneNumberId, accessToken } = waConnection;
  const tierLimit = campaign.tierLimit || 250;

  // Check rolling 24h sent count across ALL campaigns for this garage
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recentSentCount = await prisma.outboundContact.count({
    where: {
      garageId: campaign.garageId,
      status: 'sent',
      updatedAt: { gte: twentyFourHoursAgo },
    },
  });
  const availableQuota = Math.max(0, tierLimit - recentSentCount);

  if (availableQuota === 0) {
    // Already at limit — queue immediately without sending anything
    const resumeAt = new Date(Date.now() + 24.5 * 60 * 60 * 1000);
    await prisma.outboundCampaign.update({
      where: { id: campaign.id },
      data: { status: 'queued', resumeAt },
    });
    console.log(`[OUTBOUND] Campaign ${campaign.id} queued immediately — ${recentSentCount} already sent in last 24h (limit: ${tierLimit})`);
    return { sent: campaign.sentCount || 0, remaining: campaign.contacts.length, status: 'queued' };
  }

  console.log(`[OUTBOUND] Rolling 24h: ${recentSentCount} sent, ${availableQuota} available (limit: ${tierLimit})`);

  await prisma.outboundCampaign.update({
    where: { id: campaign.id },
    data: { status: 'sending' },
  });

  const optedOutContacts = await prisma.outboundContact.findMany({
    where: { garageId: campaign.garageId, status: 'opted_out' },
    select: { phone: true },
  });
  const dncSet = new Set(optedOutContacts.map((c) => c.phone));

  let sentCount = campaign.sentCount || 0;
  let batchSent = 0;

  for (const contact of campaign.contacts) {
    if (batchSent >= availableQuota) {
      console.log(`[OUTBOUND] Available quota (${availableQuota}) exhausted for campaign ${campaign.id}, queuing remainder`);
      break;
    }

    if (dncSet.has(contact.phone)) {
      console.log(`[OUTBOUND] Skipping DNC number ${contact.phone}`);
      await prisma.outboundContact.update({
        where: { id: contact.id },
        data: { status: 'opted_out' },
      });
      continue;
    }

    try {
      const e164 = normalisePhone(contact.phone);

      const contactFields: Record<string, string> = {
        customer_name: contact.customerName?.trim().split(/\s+/)[0] || contact.customerName,
        full_name: contact.customerName,
        phone: contact.phone,
        registration: contact.registration?.toUpperCase() || '',
        mot_due_date: contact.motDueDate || '',
        service_due_date: contact.serviceDueDate || '',
        garage_name: garageName,
      };

      let payload: Record<string, unknown>;

      if (template && campaign.messageTemplateId) {
        const parameters = Object.keys(variableMapping)
          .sort((a, b) => Number(a) - Number(b))
          .map((varNum) => ({
            type: 'text',
            text: contactFields[variableMapping[varNum]] || '',
          }));

        const emptyParam = parameters.find((p) => !p.text);
        if (emptyParam) {
          const missingVar = Object.entries(variableMapping).find(
            ([, field]) => !contactFields[field]
          );
          console.warn(`[OUTBOUND] Skipping ${e164}: template variable "${missingVar?.[1] || 'unknown'}" is empty`);
          await prisma.outboundContact.update({
            where: { id: contact.id },
            data: { status: 'failed', errorReason: `Missing template variable: ${missingVar?.[1] || 'unknown'}` },
          });
          continue;
        }

        payload = {
          messaging_product: 'whatsapp',
          to: e164,
          type: 'template',
          template: {
            name: template.name,
            language: { code: template.language || 'en_GB' },
            ...(parameters.length > 0 && {
              components: [{ type: 'body', parameters }],
            }),
          },
        };
      } else {
        const dueDate = contact.motDueDate || contact.serviceDueDate || 'soon';
        const body = buildMessage(
          contact.customerName,
          contact.messageType,
          dueDate,
          contact.registration,
          garageName,
        );
        payload = {
          messaging_product: 'whatsapp',
          to: e164,
          type: 'text',
          text: { body },
        };
      }

      const metaRes = await axios.post(
        `https://graph.facebook.com/v18.0/${whatsappPhoneNumberId}/messages`,
        payload,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const messageSid = metaRes.data?.messages?.[0]?.id || null;

      await prisma.outboundContact.update({
        where: { id: contact.id },
        data: { status: 'sent', messageSid },
      });

      sentCount++;
      batchSent++;
    } catch (err: unknown) {
      const metaError = (err as { response?: { data?: { error?: { message?: string; code?: number } } } })?.response?.data;
      const errorCode = metaError?.error?.code;
      console.error(`[OUTBOUND] Failed to send to ${contact.phone}:`, metaError ?? err);
      const errorReason = metaError?.error?.message || 'Send failed';

      if (errorCode === 131048) {
        // Rate limited — keep this contact as pending so the next batch retries it
        console.log(`[OUTBOUND] Meta rate limit hit (131048) for campaign ${campaign.id}, keeping contact pending for retry`);
        break;
      }

      await prisma.outboundContact.update({
        where: { id: contact.id },
        data: { status: 'failed', errorReason },
      });
    }
  }

  const remainingPending = await prisma.outboundContact.count({
    where: { campaignId: campaign.id, status: 'pending' },
  });

  let finalStatus: string;
  if (remainingPending > 0) {
    const resumeAt = new Date(Date.now() + 24.5 * 60 * 60 * 1000);
    finalStatus = 'queued';
    await prisma.outboundCampaign.update({
      where: { id: campaign.id },
      data: { status: 'queued', sentAt: new Date(), sentCount, resumeAt },
    });
    console.log(`[OUTBOUND] Campaign ${campaign.id} queued: ${sentCount} sent, ${remainingPending} remaining, resumes at ${resumeAt.toISOString()}`);
  } else {
    finalStatus = sentCount === 0 ? 'failed' : 'processed';
    await prisma.outboundCampaign.update({
      where: { id: campaign.id },
      data: { status: finalStatus, sentAt: new Date(), sentCount, resumeAt: null },
    });
    console.log(`[OUTBOUND] Campaign ${campaign.id} ${finalStatus}: ${sentCount}/${campaign.totalContacts}`);
  }

  return { sent: sentCount, remaining: remainingPending, status: finalStatus };
}

/** Process all queued campaigns whose resumeAt has passed — called by the cron job */
export async function processQueuedCampaigns(): Promise<{ processed: number }> {
  const now = new Date();
  const queuedCampaigns = await prisma.outboundCampaign.findMany({
    where: {
      status: 'queued',
      resumeAt: { lte: now },
    },
    select: { id: true, name: true },
  });

  if (queuedCampaigns.length === 0) return { processed: 0 };

  console.log(`[OUTBOUND-CRON] Found ${queuedCampaigns.length} queued campaign(s) ready to resume`);

  for (const qc of queuedCampaigns) {
    console.log(`[OUTBOUND-CRON] Resuming campaign ${qc.id} (${qc.name})`);
    try {
      const result = await sendCampaignBatch(qc.id);
      console.log(`[OUTBOUND-CRON] Campaign ${qc.id}: ${result.sent} total sent, ${result.remaining} remaining, status=${result.status}`);
    } catch (error) {
      console.error(`[OUTBOUND-CRON] Failed to resume campaign ${qc.id}:`, error);
    }
  }

  return { processed: queuedCampaigns.length };
}

// ---------------------------------------------------------------------------
// POST /api/outbound/campaigns/:id/send — send messages to all pending contacts
// ---------------------------------------------------------------------------
router.post('/outbound/campaigns/:id/send', authenticate, async (req: Request, res: Response) => {
  try {
    const campaign = await prisma.outboundCampaign.findUnique({
      where: { id: req.params.id },
      include: { contacts: { where: { status: 'pending' } } },
    });

    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    if (campaign.status === 'sent' || campaign.status === 'processed') {
      return res.status(400).json({ error: 'Campaign already sent' });
    }

    if (campaign.status === 'queued') {
      const resumeAt = campaign.resumeAt ? new Date(campaign.resumeAt).toISOString() : 'unknown';
      return res.status(400).json({
        error: `Campaign is queued and will automatically send the next batch at ${resumeAt}. Please wait for the daily limit to reset.`,
      });
    }

    if (campaign.contacts.length === 0) {
      return res.status(400).json({ error: 'No pending contacts to send to' });
    }

    // Validate WhatsApp config before responding
    const waConnection = await prisma.socialMediaConnection.findFirst({
      where: { garageId: campaign.garageId, platform: 'whatsapp', isActive: true },
      select: { whatsappPhoneNumberId: true },
    });

    if (!waConnection?.whatsappPhoneNumberId || waConnection.whatsappPhoneNumberId === 'pending_setup') {
      await prisma.outboundCampaign.update({ where: { id: campaign.id }, data: { status: 'draft' } });
      return res.status(400).json({ error: 'No WhatsApp sender configured for this garage' });
    }

    if (campaign.channel === 'whatsapp' && !campaign.messageTemplateId) {
      await prisma.outboundCampaign.update({ where: { id: campaign.id }, data: { status: 'draft' } });
      return res.status(400).json({ error: 'WhatsApp campaigns require an approved template. Please select a template and try again.' });
    }

    const tierLimit = campaign.tierLimit || 250;
    const pendingCount = campaign.contacts.length;

    // Check rolling 24h usage so the response message is accurate
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentSentCount = await prisma.outboundContact.count({
      where: {
        garageId: campaign.garageId,
        status: 'sent',
        updatedAt: { gte: twentyFourHoursAgo },
      },
    });
    const availableQuota = Math.max(0, tierLimit - recentSentCount);
    const willSend = Math.min(pendingCount, availableQuota);
    const willQueue = pendingCount - willSend;

    if (availableQuota === 0) {
      // At limit already — queue without sending, don't fire background job
      const resumeAt = new Date(Date.now() + 24.5 * 60 * 60 * 1000);
      await prisma.outboundCampaign.update({
        where: { id: campaign.id },
        data: { status: 'queued', resumeAt },
      });
      return res.json({
        success: true,
        message: `Daily limit reached (${recentSentCount}/${tierLimit} sent in last 24h). All ${pendingCount} contacts queued — next batch at ${resumeAt.toLocaleString('en-GB', { timeZone: 'Europe/London' })}.`,
      });
    }

    res.json({
      success: true,
      message: willQueue > 0
        ? `Sending ${willSend} of ${pendingCount} contacts now (${recentSentCount} already sent today, limit: ${tierLimit}/day). ${willQueue} will be queued for tomorrow.`
        : `Sending all ${willSend} contacts now (${recentSentCount} already sent today, limit: ${tierLimit}/day).`,
    });

    // Fire the batch send in background
    sendCampaignBatch(campaign.id).catch((err) => {
      console.error(`[OUTBOUND] Background send failed for campaign ${campaign.id}:`, err);
    });
  } catch (error) {
    console.error('[OUTBOUND] Send campaign error:', error);
    res.status(500).json({ error: 'Failed to send campaign' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/sms/inbound — Twilio webhook for inbound SMS + WhatsApp replies
// Twilio sends application/x-www-form-urlencoded: From, To, Body, MessageSid
// ---------------------------------------------------------------------------
router.post('/sms/inbound', async (req: Request, res: Response) => {
  // Respond 200 immediately so Twilio doesn't retry
  res.set('Content-Type', 'text/xml');

  try {
    const { From, Body, To } = req.body as { From: string; Body: string; To: string };

    if (!From || !Body) {
      res.send('<Response></Response>');
      return;
    }

    const normalFrom = normalisePhone(From);
    const channel = From.toLowerCase().startsWith('whatsapp:') ? 'whatsapp' : 'sms';

    console.log(`[OUTBOUND_INBOUND] ${channel} from ${normalFrom}: ${Body}`);

    // Find the most recent sent contact for this phone
    const contact = await prisma.outboundContact.findFirst({
      where: {
        phone: normalFrom,
        status: { in: ['sent', 'replied'] },
      },
      include: { campaign: true },
      orderBy: { createdAt: 'desc' },
    });

    // Opt-out handling
    const optOutPattern = /^\s*(stop|no|unsubscribe|cancel|quit|end)\s*$/i;
    if (optOutPattern.test(Body.trim())) {
      if (contact) {
        await prisma.outboundContact.update({
          where: { id: contact.id },
          data: { status: 'opted_out' },
        });
      }
      res.send(
        '<Response><Message>No problem, you won\'t hear from us again.</Message></Response>',
      );
      return;
    }

    if (!contact) {
      // Unknown sender — ignore silently
      res.send('<Response></Response>');
      return;
    }

    const garageId = contact.garageId;

    // Find or create conversation
    let conversation = await prisma.chatConversation.findFirst({
      where: {
        garageId,
        platform: channel,
        customerPhone: normalFrom,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!conversation) {
      // Pre-populate sessionState so agent already knows name/phone/reg
      const sessionState: Record<string, string> = {
        contactPhone: normalFrom,
      };
      const nameParts = contact.customerName.trim().split(/\s+/);
      sessionState.customerNameFirst = nameParts[0] || '';
      sessionState.customerNameLast = nameParts.slice(1).join(' ') || '';

      const dueDate = contact.motDueDate || contact.serviceDueDate || '';
      const contextNote = [
        `Customer replied to outbound ${contact.messageType === 'mot' ? 'MOT' : 'service'} reminder.`,
        contact.registration ? `Vehicle registration: ${contact.registration.toUpperCase()}.` : '',
        dueDate ? `Due date: ${dueDate}.` : '',
      ]
        .filter(Boolean)
        .join(' ');

      conversation = await prisma.chatConversation.create({
        data: {
          garageId,
          platform: channel,
          customerPhone: normalFrom,
          platformUserId: normalFrom,
          customerName: contact.customerName,
          status: 'active',
          sessionState,
          unreadCount: 1,
          lastMessageAt: new Date(),
        },
      });

      // Seed a hidden context message so agent has background
      await prisma.chatMessage.create({
        data: {
          conversationId: conversation.id,
          role: 'assistant',
          content: `[Context: ${contextNote}]`,
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

    // Mark contact as replied
    await prisma.outboundContact.update({
      where: { id: contact.id },
      data: { status: 'replied', conversationId: conversation.id },
    });

    // Save inbound message
    await prisma.chatMessage.create({
      data: {
        conversationId: conversation.id,
        role: 'user',
        content: Body,
      },
    });

    // Get AI response
    const agentResponse = await routeChatMessage(
      garageId,
      Body,
      conversation.id,
      { phone: normalFrom, name: contact.customerName },
    );

    // Save AI response
    await prisma.chatMessage.create({
      data: {
        conversationId: conversation.id,
        role: 'assistant',
        content: agentResponse.content,
      },
    });

    // Reply via TwiML
    const escaped = agentResponse.content
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    res.send(`<Response><Message>${escaped}</Message></Response>`);
  } catch (error) {
    console.error('[OUTBOUND_INBOUND] Error:', error);
    res.send('<Response></Response>');
  }
});

export default router;
