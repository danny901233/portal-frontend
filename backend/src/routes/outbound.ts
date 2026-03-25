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
        messageTemplateId: messageTemplateId || null,
        variableMapping: variableMapping || null,
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

    if (campaign.status === 'sent') {
      return res.status(400).json({ error: 'Campaign already sent' });
    }

    if (campaign.contacts.length === 0) {
      return res.status(400).json({ error: 'No pending contacts to send to' });
    }

    // Get garage name, Meta WhatsApp connection, and optional template from DB
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
      await prisma.outboundCampaign.update({ where: { id: campaign.id }, data: { status: 'draft' } });
      return res.status(400).json({ error: 'No WhatsApp sender configured for this garage' });
    }

    const { whatsappPhoneNumberId, accessToken } = waConnection;

    // Mark campaign as sending
    await prisma.outboundCampaign.update({
      where: { id: campaign.id },
      data: { status: 'sending' },
    });

    // Respond immediately — send in background
    res.json({ success: true, message: `Sending to ${campaign.contacts.length} contacts` });

    // Build DNC set — phones that have ever opted out for this garage
    const optedOutContacts = await prisma.outboundContact.findMany({
      where: { garageId: campaign.garageId, status: 'opted_out' },
      select: { phone: true },
    });
    const dncSet = new Set(optedOutContacts.map((c) => c.phone));

    let sentCount = 0;

    for (const contact of campaign.contacts) {
      // Cross-campaign DNC check
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

        // Build contact field lookup for variable substitution
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
          // Use approved Meta template with variable substitution
          const parameters = Object.keys(variableMapping)
            .sort((a, b) => Number(a) - Number(b))
            .map((varNum) => ({
              type: 'text',
              text: contactFields[variableMapping[varNum]] || '',
            }));

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
          // Fall back to hardcoded plain text message
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

        // Send via Meta WhatsApp Cloud API
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
      } catch (err: unknown) {
        const metaError = (err as { response?: { data?: unknown } })?.response?.data;
        console.error(`[OUTBOUND] Failed to send to ${contact.phone}:`, metaError ?? err);
        await prisma.outboundContact.update({
          where: { id: contact.id },
          data: { status: 'failed' },
        });
      }
    }

    const finalStatus = sentCount === 0 ? 'failed' : 'processed';
    await prisma.outboundCampaign.update({
      where: { id: campaign.id },
      data: { status: finalStatus, sentAt: new Date(), sentCount },
    });

    console.log(`[OUTBOUND] Campaign ${campaign.id} ${finalStatus}: ${sentCount}/${campaign.contacts.length}`);
  } catch (error) {
    console.error('[OUTBOUND] Send campaign error:', error);
    // Response may already be sent — just log
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
