import type { Request, Response } from 'express';
import { Router } from 'express';
import twilio from 'twilio';
import { prisma } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { routeChatMessage } from '../services/chatAgentRouter.js';

const router = Router();

function getTwilioClient() {
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

/** Normalise phone to E.164-ish for matching (strip whatsapp: prefix, collapse spaces) */
function normalisePhone(raw: string): string {
  return raw.replace(/^whatsapp:/i, '').replace(/\s+/g, '');
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
    return `Hi ${firstName}, your service is due on ${dueDate}${reg}. Would you like to book it in at ${garageName}? Reply YES to get booked in, or STOP to opt out.`;
  }
  return `Hi ${firstName}, your MOT is due on ${dueDate}${reg}. Would you like to book it in at ${garageName}? Reply YES to get booked in, or STOP to opt out.`;
}

// ---------------------------------------------------------------------------
// POST /api/outbound/campaigns — create campaign + bulk import contacts
// ---------------------------------------------------------------------------
router.post('/outbound/campaigns', authenticate, async (req: Request, res: Response) => {
  try {
    const { garageId, name, channel, contacts } = req.body as {
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

    // Get garage name for message
    const agentConfig = await prisma.agentConfiguration.findUnique({
      where: { garageId: campaign.garageId },
      select: { branchName: true },
    });
    const garageName = agentConfig?.branchName || 'our garage';

    const twilioClient = getTwilioClient();
    const fromNumber = process.env.TWILIO_PHONE_NUMBER || '';
    const fromWhatsApp = `whatsapp:${fromNumber}`;

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
        const dueDate = contact.motDueDate || contact.serviceDueDate || 'soon';
        const body = buildMessage(
          contact.customerName,
          contact.messageType,
          dueDate,
          contact.registration,
          garageName,
        );

        const toNumber =
          campaign.channel === 'whatsapp'
            ? `whatsapp:${contact.phone}`
            : contact.phone;

        const msg = await twilioClient.messages.create({
          body,
          from: campaign.channel === 'whatsapp' ? fromWhatsApp : fromNumber,
          to: toNumber,
        });

        await prisma.outboundContact.update({
          where: { id: contact.id },
          data: { status: 'sent', messageSid: msg.sid },
        });

        sentCount++;
      } catch (err) {
        console.error(`[OUTBOUND] Failed to send to ${contact.phone}:`, err);
        await prisma.outboundContact.update({
          where: { id: contact.id },
          data: { status: 'failed' },
        });
      }
    }

    await prisma.outboundCampaign.update({
      where: { id: campaign.id },
      data: { status: 'sent', sentAt: new Date(), sentCount },
    });

    console.log(`[OUTBOUND] Campaign ${campaign.id} sent: ${sentCount}/${campaign.contacts.length}`);
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
