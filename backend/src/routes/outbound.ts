import type { Request, Response } from 'express';
import { Router } from 'express';
import twilio from 'twilio';
import { prisma } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { routeChatMessage } from '../services/chatAgentRouter.js';
import { resolveCreds, getReminderContacts, getCallerProfile, getVehicleAdvisories } from '../services/garageHiveBc.js';
import { normalisePhone, getCampaignSendContext, runCampaignSend } from '../services/outboundSend.js';
import { runGarageReminders, runDailyGarageHiveReminders } from '../services/garageHiveReminders.js';

const router = Router();

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
    const normalisedRaw = contacts.map((c) => ({
      garageId,
      customerName: c.customerName?.trim() || 'Customer',
      phone: normalisePhone(c.phone || ''),
      registration: c.registration?.trim() || null,
      motDueDate: c.motDueDate?.trim() || null,
      serviceDueDate: c.serviceDueDate?.trim() || null,
      messageType: c.motDueDate?.trim() ? 'mot' : 'service',
    }));

    // Deduplicate by phone — keep first occurrence
    const seenPhones = new Set<string>();
    const normalised = normalisedRaw.filter((c) => {
      if (!c.phone || seenPhones.has(c.phone)) return false;
      seenPhones.add(c.phone);
      return true;
    });

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
// GET /api/outbound/garagehive/preview?garageId=...&days=30
// Pull reminder contacts from Garage Hive (vehicles due MOT/service in N days),
// resolve each owner's number, and return them in the SAME shape the CSV upload
// produces — the frontend previews them, then POSTs to /outbound/campaigns like
// any other source. Garage Hive is just an alternative source to the CSV.
// ---------------------------------------------------------------------------
router.get('/outbound/garagehive/preview', authenticate, async (req: Request, res: Response) => {
  try {
    const { garageId } = req.query as { garageId: string };
    const days = Number.parseInt((req.query.days as string) || '30', 10);

    if (!garageId) {
      return res.status(400).json({ error: 'garageId required' });
    }
    if (Number.isNaN(days) || days < 0 || days > 365) {
      return res.status(400).json({ error: 'days must be between 0 and 365' });
    }

    const creds = await resolveCreds(garageId);
    if (!creds) {
      return res.status(400).json({
        error: 'Garage Hive is not connected for this garage.',
        code: 'GARAGEHIVE_NOT_CONNECTED',
      });
    }

    const { contacts, skipped } = await getReminderContacts(creds, days);
    res.json({ source: 'garagehive', days, contacts, skipped });
  } catch (error: unknown) {
    const detail = (error as { response?: { data?: unknown } })?.response?.data;
    console.error('[OUTBOUND] Garage Hive preview error:', detail ?? error);
    res.status(502).json({ error: 'Failed to fetch reminders from Garage Hive' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/agent/garagehive/caller?garageId=...&phone=... — caller recognition
// for the voice/chat agent. Auth via the shared agent webhook secret (same as
// call-log posts), NOT a user JWT, since the agent has no user session.
// ---------------------------------------------------------------------------
router.get('/agent/garagehive/caller', async (req: Request, res: Response) => {
  const configured = process.env.WEBHOOK_SECRET;
  const provided = req.headers['x-webhook-secret'] ?? req.headers['webhook-secret'];
  if (configured && provided !== configured) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const { garageId, phone } = req.query as { garageId: string; phone: string };
    if (!garageId || !phone) {
      return res.status(400).json({ error: 'garageId and phone are required' });
    }
    const profile = await getCallerProfile(garageId, phone);
    res.json(profile);
  } catch (error: unknown) {
    const detail = (error as { response?: { data?: unknown } })?.response?.data;
    console.error('[AGENT] Garage Hive caller lookup error:', detail ?? error);
    res.status(502).json({ error: 'Failed to look up caller in Garage Hive' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/agent/garagehive/advisories?garageId=...&registration=... — the
// vehicle's outstanding health-check advisories, for the voice agent to offer
// at booking time. Agent-secret auth. Returns nothing when the garage toggle is
// off (enforced server-side).
// ---------------------------------------------------------------------------
router.get('/agent/garagehive/advisories', async (req: Request, res: Response) => {
  const configured = process.env.WEBHOOK_SECRET;
  const provided = req.headers['x-webhook-secret'] ?? req.headers['webhook-secret'];
  if (configured && provided !== configured) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const { garageId, registration } = req.query as { garageId: string; registration: string };
    if (!garageId || !registration) {
      return res.status(400).json({ error: 'garageId and registration are required' });
    }
    const result = await getVehicleAdvisories(garageId, registration);
    res.json(result);
  } catch (error: unknown) {
    const detail = (error as { response?: { data?: unknown } })?.response?.data;
    console.error('[AGENT] Garage Hive advisories error:', detail ?? error);
    res.status(502).json({ error: 'Failed to look up advisories in Garage Hive' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/garagehive/caller?garageId=...&phone=... — caller recognition.
// Resolve an inbound number to the Garage Hive customer + their vehicles (with
// MOT/service due dates) so the agent can greet them by name with context.
// Read-only.
// ---------------------------------------------------------------------------
router.get('/garagehive/caller', authenticate, async (req: Request, res: Response) => {
  try {
    const { garageId, phone } = req.query as { garageId: string; phone: string };
    if (!garageId || !phone) {
      return res.status(400).json({ error: 'garageId and phone are required' });
    }
    const profile = await getCallerProfile(garageId, phone);
    res.json(profile);
  } catch (error: unknown) {
    const detail = (error as { response?: { data?: unknown } })?.response?.data;
    console.error('[OUTBOUND] Garage Hive caller lookup error:', detail ?? error);
    res.status(502).json({ error: 'Failed to look up caller in Garage Hive' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/outbound/garagehive/settings?garageId=... — daily reminder settings
// ---------------------------------------------------------------------------
router.get('/outbound/garagehive/settings', authenticate, async (req: Request, res: Response) => {
  try {
    const { garageId } = req.query as { garageId: string };
    if (!garageId) return res.status(400).json({ error: 'garageId required' });

    // Is this garage on the Garage Hive agent? (gates the advisory-upsell option)
    const agentCfg = await prisma.agentConfiguration.findUnique({
      where: { garageId },
      select: { agentType: true, agentScript: true },
    });
    const isGarageHiveAgent =
      agentCfg?.agentType === 'automate' || agentCfg?.agentScript === 'GarageHive-agent';

    const conn = await prisma.garageHiveConnection.findUnique({ where: { garageId } });
    if (!conn) {
      return res.json({ connected: false, isGarageHiveAgent });
    }
    res.json({
      connected: true,
      isGarageHiveAgent,
      remindersEnabled: conn.remindersEnabled,
      reminderDaysAhead: conn.reminderDaysAhead,
      reminderTemplateId: conn.reminderTemplateId,
      reminderChannel: conn.reminderChannel,
      advisoryUpsellsEnabled: conn.advisoryUpsellsEnabled,
      lastRunAt: conn.lastRunAt,
      lastRunError: conn.lastRunError,
    });
  } catch (error) {
    console.error('[OUTBOUND] Garage Hive settings get error:', error);
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/outbound/garagehive/settings — update daily reminder settings
// ---------------------------------------------------------------------------
router.put('/outbound/garagehive/settings', authenticate, async (req: Request, res: Response) => {
  try {
    const {
      garageId,
      remindersEnabled,
      reminderDaysAhead,
      reminderTemplateId,
      advisoryUpsellsEnabled,
    } = (req.body || {}) as {
      garageId?: string;
      remindersEnabled?: boolean;
      reminderDaysAhead?: number;
      reminderTemplateId?: string | null;
      advisoryUpsellsEnabled?: boolean;
    };
    if (!garageId) return res.status(400).json({ error: 'garageId required' });

    const conn = await prisma.garageHiveConnection.findUnique({ where: { garageId } });
    if (!conn) {
      return res.status(400).json({
        error: 'Garage Hive is not connected for this garage yet. Connection must be set up first.',
        code: 'GARAGEHIVE_NOT_CONNECTED',
      });
    }

    if (typeof reminderDaysAhead === 'number' && (reminderDaysAhead < 0 || reminderDaysAhead > 365)) {
      return res.status(400).json({ error: 'reminderDaysAhead must be between 0 and 365' });
    }
    // Auto-send over WhatsApp needs an approved template.
    if (remindersEnabled && !reminderTemplateId) {
      return res.status(400).json({ error: 'Select an approved WhatsApp template before enabling automatic reminders.' });
    }
    // Advisory upsells are only for garages on the Garage Hive agent.
    if (advisoryUpsellsEnabled) {
      const agentCfg = await prisma.agentConfiguration.findUnique({
        where: { garageId },
        select: { agentType: true, agentScript: true },
      });
      const isGarageHiveAgent =
        agentCfg?.agentType === 'automate' || agentCfg?.agentScript === 'GarageHive-agent';
      if (!isGarageHiveAgent) {
        return res.status(400).json({ error: 'Advisory upsells are only available on the Garage Hive agent.' });
      }
    }

    const updated = await prisma.garageHiveConnection.update({
      where: { garageId },
      data: {
        ...(typeof remindersEnabled === 'boolean' && { remindersEnabled }),
        ...(typeof reminderDaysAhead === 'number' && { reminderDaysAhead }),
        ...(reminderTemplateId !== undefined && { reminderTemplateId }),
        ...(typeof advisoryUpsellsEnabled === 'boolean' && { advisoryUpsellsEnabled }),
      },
    });
    res.json({
      connected: true,
      remindersEnabled: updated.remindersEnabled,
      reminderDaysAhead: updated.reminderDaysAhead,
      reminderTemplateId: updated.reminderTemplateId,
      reminderChannel: updated.reminderChannel,
      advisoryUpsellsEnabled: updated.advisoryUpsellsEnabled,
      lastRunAt: updated.lastRunAt,
      lastRunError: updated.lastRunError,
    });
  } catch (error) {
    console.error('[OUTBOUND] Garage Hive settings update error:', error);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/outbound/garagehive/run-now — manually trigger the reminder run
// (the same job the daily cron runs). Body: { garageId? } — run one garage, or
// all enabled connections when omitted. For testing + on-demand sends.
// ---------------------------------------------------------------------------
router.post('/outbound/garagehive/run-now', authenticate, async (req: Request, res: Response) => {
  try {
    const { garageId } = (req.body || {}) as { garageId?: string };

    if (garageId) {
      const conn = await prisma.garageHiveConnection.findUnique({ where: { garageId } });
      if (!conn) {
        return res.status(400).json({ error: 'No Garage Hive connection configured for this garage.' });
      }
      const result = await runGarageReminders(conn);
      return res.json({ results: [result] });
    }

    const results = await runDailyGarageHiveReminders();
    res.json({ results });
  } catch (error) {
    console.error('[OUTBOUND] Garage Hive run-now error:', error);
    res.status(500).json({ error: 'Failed to run Garage Hive reminders' });
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
    const prepared = await getCampaignSendContext(req.params.id);
    if (!prepared.ok) {
      return res.status(prepared.code).json({ error: prepared.error });
    }

    // Mark as sending, respond immediately, then send in the background.
    await prisma.outboundCampaign.update({
      where: { id: prepared.ctx.campaign.id },
      data: { status: 'sending' },
    });
    res.json({ success: true, message: `Sending to ${prepared.ctx.campaign.contacts.length} contacts` });

    runCampaignSend(prepared.ctx).catch((error) => {
      console.error('[OUTBOUND] Send campaign error:', error);
    });
  } catch (error) {
    console.error('[OUTBOUND] Send campaign error:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to send campaign' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/sms/inbound — Twilio webhook for inbound SMS + WhatsApp replies
// Twilio sends application/x-www-form-urlencoded: From, To, Body, MessageSid
// ---------------------------------------------------------------------------
router.post('/sms/inbound', async (req: Request, res: Response) => {
  res.set('Content-Type', 'text/xml');

  // Validate Twilio signature
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    console.error('[SMS] TWILIO_AUTH_TOKEN not set — rejecting inbound SMS request');
    res.status(403).send('<Response></Response>');
    return;
  }
  const signature = req.headers['x-twilio-signature'] as string;
  const url = `${process.env.BACKEND_URL || `https://${req.headers.host}`}/api/sms/inbound`;
  const valid = twilio.validateRequest(authToken, signature, url, req.body);
  if (!valid) {
    res.status(403).send('<Response></Response>');
    return;
  }

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
