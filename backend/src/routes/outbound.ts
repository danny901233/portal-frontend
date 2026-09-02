import type { Request, Response } from 'express';
import { Router } from 'express';
import twilio from 'twilio';
import { prisma } from '../db.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { routeChatMessage } from '../services/chatAgentRouter.js';
import { parseDueDate } from '../utils/dueDate.js';
import { splitPersonName } from '../utils/personName.js';
import { resolveCreds, getReminderContacts, getCallerProfile, getVehicleAdvisories, listCompanies, testConnection, getLastServiceSuggestion } from '../services/garageHiveBc.js';
import { normalisePhone, getCampaignSendContext, runCampaignSend, activeHalt } from '../services/outboundSend.js';
import { runGarageReminders, runDailyGarageHiveReminders } from '../services/garageHiveReminders.js';

const router = Router();

// ---------------------------------------------------------------------------
// POST /api/outbound/campaigns — create campaign + bulk import contacts
// ---------------------------------------------------------------------------
router.post('/outbound/campaigns', authenticate, async (req: Request, res: Response) => {
  try {
    const { garageId, name, channel, contacts, messageTemplateId, variableMapping, campaignType, reminderStages } = req.body as {
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
      campaignType?: 'oneoff' | 'reminder';
      reminderStages?: number[];
    };

    if (!garageId || !name || !contacts || !Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Derive messageType per contact and normalise phones.
    // dueDate is the parsed form of whatever the DMS exported, kept alongside the raw string so
    // the reminder scheduler has a real date to work from. Unparseable dates land as null and
    // are counted below — never guessed, because a reminder sent on the wrong day is worse than
    // one not sent at all.
    // A chosen template is an explicit statement of intent — "this is a service campaign" — and it
    // should beat anything inferred from a spreadsheet column. Great Hollands picked
    // gh_service_overdue_reminder, the rows were typed from the date columns instead, and the two
    // disagreed: the customer was told his service was overdue and then offered an MOT.
    //
    // Only for MANUAL uploads. The automatic GarageHive sweep has no human in the loop and decides
    // per vehicle, which is right there — this does not touch it.
    let templateType: 'mot' | 'service' | null = null;
    if (messageTemplateId) {
      try {
        const tpl = await prisma.messageTemplate.findUnique({
          where: { id: messageTemplateId }, select: { name: true, templateType: true },
        });
        // The template's own type first — it is what the garage actually chose. Reading intent out
        // of the NAME is a guess, and only worth making when nothing better was recorded.
        if (tpl?.templateType === 'service' || tpl?.templateType === 'mot') {
          templateType = tpl.templateType;
        } else if (tpl?.templateType === 'deferred' || tpl?.templateType === 'marketing') {
          // Neither is a service or MOT reminder, so there is nothing to chase and nothing the
          // chat agent should pre-select. Leave the rows on the date-based rule and let the
          // conversation decide.
          templateType = null;
        } else {
          const tn = (tpl?.name || '').toLowerCase();
          const hasService = /service/.test(tn);
          const hasMot = /\bmot\b/.test(tn);
          if (hasService && !hasMot) templateType = 'service';
          else if (hasMot && !hasService) templateType = 'mot';
        }
        if (templateType) console.log(`[OUTBOUND] template "${tpl?.name}" (type=${tpl?.templateType ?? 'unset'}) -> chasing ${templateType}`);
      } catch { /* fall back to the dates */ }
    }

    const normalisedRaw = contacts.map((c) => {
      const motRaw = c.motDueDate?.trim() || null;
      const svcRaw = c.serviceDueDate?.trim() || null;
      const motDue = parseDueDate(motRaw);
      const svcDue = parseDueDate(svcRaw);

      // Classify on which job is actually DUE, not on which column happens to be filled.
      //
      // This was `motDueDate ? 'mot' : 'service'`, so any row carrying an MOT date became an MOT
      // reminder even when the MOT was years away and the service was long overdue. A Great
      // Hollands customer was reminded his service was overdue — correctly; it was due March 2025
      // — but the row was typed 'mot' with a due date of April 2027. When he replied "Book", the
      // chat agent read that type, auto-selected MOT, matched a service with no online slots and
      // told him there was no availability. Every contact that garage had was typed 'mot', and
      // every one carried both dates.
      //
      // Whichever falls first is the one to chase; the other comes round on its own sweep.
      const byDate = svcDue !== null && (motDue === null || svcDue < motDue);
      const messageType = templateType
        ?? (byDate ? 'service' : (motDue !== null ? 'mot' : (svcDue !== null ? 'service' : 'mot')));
      // Chase the date that belongs to whatever we settled on, so the reminder lands on the right day.
      const dueDate = messageType === 'service' ? (svcDue ?? motDue) : (motDue ?? svcDue);

      return {
        garageId,
        customerName: c.customerName?.trim() || 'Customer',
        phone: normalisePhone(c.phone || ''),
        registration: c.registration?.trim() || null,
        motDueDate: motRaw,
        serviceDueDate: svcRaw,
        dueDate,
        messageType,
      };
    });
    const unreadableDates = normalisedRaw.filter((c) => !c.dueDate).length;
    if (unreadableDates > 0) {
      console.warn(`[OUTBOUND] ${unreadableDates}/${normalisedRaw.length} uploaded rows had a due date we could not read — those rows will not be auto-reminded.`);
    }

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

    // A one-off (an offer, an announcement) is sent once and never chased. Only a 'reminder'
    // campaign enters the staged follow-up sweep, and it follows the stages chosen here.
    // Anything unrecognised falls back to 'oneoff' — the option that sends fewer messages.
    const type = campaignType === 'reminder' ? 'reminder' : 'oneoff';
    const stages = type === 'reminder'
      ? [...new Set((reminderStages || [30, 14, 3]).map(Number).filter((n) => Number.isFinite(n) && n > 0 && n <= 120))]
          .sort((a, b) => b - a)
      : [];
    if (type === 'reminder' && stages.length === 0) {
      return res.status(400).json({ error: 'A reminder campaign needs at least one follow-up stage (days before due).' });
    }

    const campaign = await prisma.outboundCampaign.create({
      data: {
        garageId,
        name,
        channel: channel || 'sms',
        campaignType: type,
        reminderStages: stages,
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
      // Logged rather than silently 400'd: caller recognition matching nothing looks identical to
      // "not a customer", and the difference matters. Every Call row for the Garage Hive garages
      // has an empty fromNumber, so an agent passing that through would land here every time.
      console.warn(
        `[GH_CALLER] lookup called without a number (garageId=${garageId || 'missing'}) — ` +
          `the agent must send the caller's number, or every caller reads as unrecognised`,
      );
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
// GET /api/agent/garagehive/service-history?garageId=...&registration=... — what
// the vehicle last had done and what is therefore likely due, for the voice
// agent to answer "what did I have last time?" and to recommend the next
// service. Agent-secret auth. Returns { suggestion: null } whenever we cannot
// say confidently — no configured service pairs, more than one vehicle on the
// account, or nothing recognisable on the last invoice.
// ---------------------------------------------------------------------------
router.get('/agent/garagehive/service-history', async (req: Request, res: Response) => {
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
    const suggestion = await getLastServiceSuggestion(garageId, registration);
    res.json({ suggestion });
  } catch (error: unknown) {
    const detail = (error as { response?: { data?: unknown } })?.response?.data;
    console.error('[AGENT] Garage Hive service-history error:', detail ?? error);
    res.status(502).json({ error: 'Failed to look up service history in Garage Hive' });
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
      // Returned so the connect panel can show what this garage currently points at. No secret
      // is included: clientId/clientSecret are the shared Azure AD app and never per-garage.
      tenantId: conn.tenantId,
      environmentName: conn.environmentName,
      companyId: conn.companyId,
      remindersEnabled: conn.remindersEnabled,
      reminderDaysAhead: conn.reminderDaysAhead,
      reminderTemplateId: conn.reminderTemplateId,
      reminderChannel: conn.reminderChannel,
      callerRecognitionEnabled: conn.callerRecognitionEnabled,
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
      callerRecognitionEnabled,
    } = (req.body || {}) as {
      garageId?: string;
      remindersEnabled?: boolean;
      reminderDaysAhead?: number;
      reminderTemplateId?: string | null;
      advisoryUpsellsEnabled?: boolean;
      callerRecognitionEnabled?: boolean;
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
    // Caller recognition + advisory upsells are only for garages on the Garage Hive agent.
    if (advisoryUpsellsEnabled || callerRecognitionEnabled) {
      const agentCfg = await prisma.agentConfiguration.findUnique({
        where: { garageId },
        select: { agentType: true, agentScript: true },
      });
      const isGarageHiveAgent =
        agentCfg?.agentType === 'automate' || agentCfg?.agentScript === 'GarageHive-agent';
      if (!isGarageHiveAgent) {
        return res.status(400).json({
          error: 'Caller recognition and advisory upsells are only available on the Garage Hive agent.',
        });
      }
    }

    const updated = await prisma.garageHiveConnection.update({
      where: { garageId },
      data: {
        ...(typeof remindersEnabled === 'boolean' && { remindersEnabled }),
        ...(typeof reminderDaysAhead === 'number' && { reminderDaysAhead }),
        ...(reminderTemplateId !== undefined && { reminderTemplateId }),
        ...(typeof advisoryUpsellsEnabled === 'boolean' && { advisoryUpsellsEnabled }),
        ...(typeof callerRecognitionEnabled === 'boolean' && { callerRecognitionEnabled }),
      },
    });
    res.json({
      connected: true,
      remindersEnabled: updated.remindersEnabled,
      reminderDaysAhead: updated.reminderDaysAhead,
      reminderTemplateId: updated.reminderTemplateId,
      reminderChannel: updated.reminderChannel,
      callerRecognitionEnabled: updated.callerRecognitionEnabled,
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
// ---------------------------------------------------------------------------
// Business Central connection — the new Garage Hive API, not the Automate diary
// ---------------------------------------------------------------------------
// A Garage Hive ACCOUNT is one BC environment (tenant + environmentName), and the branches
// inside it are COMPANIES. JDK Group is the first: JDK Automotive, Ecotest and Great Hollands
// share one environment and differ only by companyId.
//
// So the tenant and environment are entered once and the company is PICKED from what BC returns,
// never typed — they are GUIDs, and a silent typo in one is indistinguishable from a permissions
// problem when something fails three days later.
//
// Nothing here asks for a client secret. The Azure AD app is ours and shared across accounts;
// what the garage does on their side is grant that app access inside their own BC.

router.get(
  '/outbound/garagehive/companies',
  authenticate,
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const tenantId = String(req.query.tenantId || '').trim();
      const environmentName = String(req.query.environmentName || '').trim();
      if (!tenantId || !environmentName) {
        return res.status(400).json({ error: 'tenantId and environmentName are both required' });
      }
      const companies = await listCompanies(tenantId, environmentName);
      console.log(`[GH_BC] ${companies.length} companies in ${environmentName} (${tenantId})`);
      res.json({ companies });
    } catch (e: any) {
      const status = e?.response?.status;
      console.error('[GH_BC] Could not list companies:', e?.response?.data || e?.message || e);
      // 401/403 here almost always means the garage has not granted our app access yet, which is
      // the one failure the person reading this can actually do something about.
      res.status(400).json({
        error:
          status === 401 || status === 403
            ? 'Business Central rejected our app. Check the garage has granted it access inside their environment, and that the tenant ID and environment name are right.'
            : e?.response?.data?.error?.message || e?.message || 'Could not reach Business Central',
      });
    }
  },
);

router.post(
  '/outbound/garagehive/connect',
  authenticate,
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const { garageId, tenantId, environmentName, companyId } = req.body || {};
      if (!garageId || !tenantId || !environmentName || !companyId) {
        return res
          .status(400)
          .json({ error: 'garageId, tenantId, environmentName and companyId are all required' });
      }

      await prisma.garageHiveConnection.upsert({
        where: { garageId },
        create: {
          garageId,
          tenantId: String(tenantId).trim(),
          environmentName: String(environmentName).trim(),
          companyId: String(companyId).trim(),
        },
        update: {
          tenantId: String(tenantId).trim(),
          environmentName: String(environmentName).trim(),
          companyId: String(companyId).trim(),
        },
      });

      // Prove it reads before reporting success. A wrong company or a missing permission set both
      // look perfectly healthy right up until something tries to fetch data.
      const test = await testConnection(garageId);
      console.log(
        `[GH_BC] Connected ${garageId} → ${environmentName}/${companyId} (test ${test.ok ? 'passed' : 'FAILED'})`,
      );
      res.json({ success: true, test });
    } catch (e: any) {
      console.error('[GH_BC] connect failed:', e);
      res.status(500).json({ error: e?.message || 'Could not save the connection' });
    }
  },
);

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

    // Replies and bookings per campaign. "Delivered" is not an outcome — what a garage wants to
    // know at a glance is how many people wrote back and how many of those ended up booked.
    const ids = campaigns.map((c) => c.id);
    const replyRows = ids.length
      ? await prisma.outboundContact.groupBy({
          by: ['campaignId'],
          where: { campaignId: { in: ids }, status: { in: ['replied', 'booked'] } },
          _count: { _all: true },
        })
      : [];
    const repliesByCampaign = new Map(replyRows.map((r) => [r.campaignId, r._count._all]));

    // A booking is recorded on the conversation the reply started, so it needs the join.
    const linked = ids.length
      ? await prisma.outboundContact.findMany({
          where: { campaignId: { in: ids }, conversationId: { not: null } },
          select: { campaignId: true, conversationId: true },
        })
      : [];
    const bookedConvIds = new Set(
      linked.length
        ? (
            await prisma.chatConversation.findMany({
              where: { id: { in: [...new Set(linked.map((l) => l.conversationId!))] }, confirmedBooking: true },
              select: { id: true },
            })
          ).map((cv) => cv.id)
        : [],
    );
    const bookedByCampaign = new Map<string, number>();
    for (const l of linked) {
      if (l.conversationId && bookedConvIds.has(l.conversationId)) {
        bookedByCampaign.set(l.campaignId, (bookedByCampaign.get(l.campaignId) ?? 0) + 1);
      }
    }

    res.json({
      campaigns: campaigns.map((c) => ({
        ...c,
        replyCount: repliesByCampaign.get(c.id) ?? 0,
        bookedCount: bookedByCampaign.get(c.id) ?? 0,
      })),
    });
  } catch (error) {
    console.error('[OUTBOUND] List campaigns error:', error);
    res.status(500).json({ error: 'Failed to list campaigns' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/outbound/limits?garageId= — daily allowance, what's left, and whether
// sending is currently halted. Read-only for everyone; only staff can change it.
// ---------------------------------------------------------------------------
router.get('/outbound/limits', authenticate, async (req: Request, res: Response) => {
  try {
    const { garageId } = req.query as { garageId: string };
    if (!garageId) return res.status(400).json({ error: 'garageId required' });

    const garage = await prisma.garage.findUnique({
      where: { id: garageId },
      select: { dailyMessageLimit: true },
    });
    if (!garage) return res.status(404).json({ error: 'Garage not found' });

    // Same counting rule the send loop uses: successful sends in the rolling 24h.
    const windowStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const counted = { garageId, status: { in: ['sent', 'delivered', 'read', 'replied'] }, updatedAt: { gte: windowStart } };
    const sentLast24h = await prisma.outboundContact.count({ where: counted });

    // The allowance is a rolling window, not a midnight reset, so "when does it reset" has two
    // honest answers: when the oldest message drops out (allowance starts freeing up) and when
    // the newest does (back to a full allowance). Showing both beats implying a midnight tick.
    const [oldest, newest] = await Promise.all([
      prisma.outboundContact.findFirst({ where: counted, orderBy: { updatedAt: 'asc' }, select: { updatedAt: true } }),
      prisma.outboundContact.findFirst({ where: counted, orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } }),
    ]);
    const plus24h = (d?: Date | null) => (d ? new Date(d.getTime() + 24 * 60 * 60 * 1000).toISOString() : null);

    const halt = await activeHalt(garageId);

    res.json({
      dailyLimit: garage.dailyMessageLimit,
      sentLast24h,
      remaining: Math.max(0, garage.dailyMessageLimit - sentLast24h),
      nextFreeAt: plus24h(oldest?.updatedAt),
      fullyFreeAt: plus24h(newest?.updatedAt),
      sendWindow: { startHour: 8, endHour: 20, timezone: 'Europe/London' },
      halt: halt ? { reason: halt.haltReason, haltedAt: halt.haltedAt, campaignName: halt.name } : null,
      canEditLimit: req.user?.role === 'RECEPTIONMATE_STAFF',
    });
  } catch (error) {
    console.error('[OUTBOUND] Limits error:', error);
    res.status(500).json({ error: 'Failed to load limits' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/outbound/limits — ReceptionMate staff only.
// A garage raising its own sending cap is precisely the decision that costs it
// its WhatsApp number, so this is deliberately not self-serve.
// ---------------------------------------------------------------------------
router.patch('/outbound/limits', authenticate, requireAdmin, async (req: Request, res: Response) => {
  try {
    const { garageId, dailyMessageLimit } = req.body as { garageId?: string; dailyMessageLimit?: number };
    if (!garageId) return res.status(400).json({ error: 'garageId required' });

    const n = Number(dailyMessageLimit);
    if (!Number.isFinite(n) || n < 1 || n > 10_000) {
      return res.status(400).json({ error: 'dailyMessageLimit must be between 1 and 10000' });
    }

    const garage = await prisma.garage.update({
      where: { id: garageId },
      data: { dailyMessageLimit: Math.floor(n) },
      select: { id: true, name: true, dailyMessageLimit: true },
    });
    console.log(`[OUTBOUND] Daily limit for ${garage.name} set to ${garage.dailyMessageLimit} by ${req.user?.email}`);
    res.json({ success: true, garage });
  } catch (error) {
    console.error('[OUTBOUND] Update limit error:', error);
    res.status(500).json({ error: 'Failed to update limit' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/outbound/limits/resume — ReceptionMate staff only. Clears a halt
// early, once someone has actually looked at why it fired.
// ---------------------------------------------------------------------------
router.post('/outbound/limits/resume', authenticate, requireAdmin, async (req: Request, res: Response) => {
  try {
    const { garageId } = req.body as { garageId?: string };
    if (!garageId) return res.status(400).json({ error: 'garageId required' });

    const cleared = await prisma.outboundCampaign.updateMany({
      where: { garageId, haltedAt: { not: null } },
      data: { haltedAt: null, haltReason: null },
    });
    console.log(`[OUTBOUND] Halt cleared for garage ${garageId} by ${req.user?.email} (${cleared.count} campaigns)`);
    res.json({ success: true, cleared: cleared.count });
  } catch (error) {
    console.error('[OUTBOUND] Resume error:', error);
    res.status(500).json({ error: 'Failed to resume sending' });
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

    // The outcome of a campaign lives on the conversation the reply started: whether the agent
    // confirmed a booking, and for what. Without it the results table can only say "delivered",
    // which tells a garage nothing about whether the campaign actually worked.
    // Fetched separately rather than via a relation — OutboundContact.conversationId is a loose
    // id with no foreign key, so some rows point at conversations that have since been deleted.
    const convIds = [...new Set(campaign.contacts.map((c) => c.conversationId).filter(Boolean))] as string[];
    const conversations = convIds.length
      ? await prisma.chatConversation.findMany({
          where: { id: { in: convIds } },
          select: {
            id: true, confirmedBooking: true, bookingDetails: true,
            needsAttention: true, lastMessageAt: true, unreadCount: true,
          },
        })
      : [];
    const convById = new Map(conversations.map((cv) => [cv.id, cv]));

    const contacts = campaign.contacts.map((ct) => ({
      ...ct,
      conversation: ct.conversationId ? convById.get(ct.conversationId) ?? null : null,
    }));

    res.json({ campaign: { ...campaign, contacts } });
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
      // Titles are dropped: a campaign CSV holding "Mr Kris Cottrell" used to seed "Mr" as the
      // first name, and the agent opened with "Hi Mr".
      const seededName = splitPersonName(contact.customerName);
      sessionState.customerNameFirst = seededName.first;
      sessionState.customerNameLast = seededName.last;

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
