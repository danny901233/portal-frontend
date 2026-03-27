import type { AgentConfiguration as PrismaAgentConfiguration, AgentKnowledgeDocument as PrismaKnowledgeDocument } from '@prisma/client';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { Router } from 'express';
import { prisma } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { requireManager } from '../middleware/auth.js';
import { resolveAllowedGarages } from '../utils/auth.js';
import { upsertAgentConfigurationSchema, weeklyOpeningHoursSchema, websiteScanSchema } from '../utils/validators.js';
import {
  cloneGarageHiveSettings,
  cloneTyresoftSettings,
  cloneWeeklyOpeningHours,
  createDefaultGarageHiveSettings,
  createDefaultTyresoftSettings,
  createDefaultWeeklyOpeningHours,
} from '../utils/types.js';
import type {
  AgentConfigurationPayload,
  GarageHiveSettings,
  IntegrationProvider,
  ResponseSpeed,
  TyresoftSettings,
  WeeklyOpeningHours,
} from '../utils/types.js';
import {
  discoverWebsitePages,
  scrapeWebsitePage,
  type WebsitePageAnalysis,
} from '../utils/scraper.js';

const router = Router();

const WEBSITE_KNOWLEDGE_SOURCE = 'website-scan';
const MAX_SELECTED_PAGES = 20;

const stripTrailingSlash = (path: string) => {
  if (path === '/') {
    return '/';
  }
  const trimmed = path.replace(/\/+$/, '');
  return trimmed || '/';
};

const normaliseUrlForSelection = (input: string) => {
  const url = new URL(input);
  url.hash = '';
  url.pathname = stripTrailingSlash(url.pathname);
  url.searchParams.sort();
  return url;
};

const sanitiseSelectedUrls = (baseUrl: string, selectedUrls: string[]) => {
  const base = normaliseUrlForSelection(baseUrl);
  const allowedHost = base.hostname;
  const unique = new Set<string>();
  const sanitized: string[] = [];

  for (const candidate of selectedUrls) {
    if (sanitized.length >= MAX_SELECTED_PAGES) {
      break;
    }
    try {
      const url = normaliseUrlForSelection(candidate);
      if (!['http:', 'https:'].includes(url.protocol)) {
        continue;
      }
      if (url.hostname !== allowedHost) {
        continue;
      }
      const serialized = url.toString();
      if (unique.has(serialized)) {
        continue;
      }
      unique.add(serialized);
      sanitized.push(serialized);
    } catch {
      // Ignore malformed URLs at this stage.
    }
  }

  return sanitized;
};

const parseWeeklyOpeningHours = (value: unknown): WeeklyOpeningHours => {
  const parsed = weeklyOpeningHoursSchema.safeParse(value);
  if (parsed.success) {
    return cloneWeeklyOpeningHours(parsed.data);
  }
  return createDefaultWeeklyOpeningHours();
};

const parseIntegrationSettings = (
  providerValue: string | null | undefined,
  rawSettings: Prisma.JsonValue | null | undefined,
  agentScript?: string | null,
): { integrationProvider: IntegrationProvider; garageHiveSettings: GarageHiveSettings; tyresoftSettings: TyresoftSettings } => {
  // Tyresoft agent takes priority — check agentScript first regardless of integrationProvider
  if (agentScript === 'tyresoft-agent') {
    if (rawSettings && typeof rawSettings === 'object' && !Array.isArray(rawSettings)) {
      const raw = rawSettings as Record<string, unknown>;
      return {
        integrationProvider: 'none',
        garageHiveSettings: createDefaultGarageHiveSettings(),
        tyresoftSettings: cloneTyresoftSettings({
          tsWorkspace: typeof raw.tsWorkspace === 'string' ? raw.tsWorkspace : (typeof raw.workspace === 'string' ? raw.workspace : ''),
          tsUsername: typeof raw.tsUsername === 'string' ? raw.tsUsername : (typeof raw.username === 'string' ? raw.username : ''),
          tsPassword: typeof raw.tsPassword === 'string' ? raw.tsPassword : (typeof raw.password === 'string' ? raw.password : ''),
          tsApiKey: typeof raw.tsApiKey === 'string' ? raw.tsApiKey : (typeof raw.apiKey === 'string' ? raw.apiKey : ''),
          tsDepotId: raw.tsDepotId != null ? String(raw.tsDepotId) : (raw.depotId != null ? String(raw.depotId) : ''),
        }),
      };
    }
    return {
      integrationProvider: 'none',
      garageHiveSettings: createDefaultGarageHiveSettings(),
      tyresoftSettings: createDefaultTyresoftSettings(),
    };
  }

  const provider: IntegrationProvider = providerValue === 'garage_hive' ? 'garage_hive' : 'none';

  if (provider !== 'garage_hive') {
    return {
      integrationProvider: 'none',
      garageHiveSettings: createDefaultGarageHiveSettings(),
      tyresoftSettings: createDefaultTyresoftSettings(),
    };
  }

  if (!rawSettings || typeof rawSettings !== 'object' || Array.isArray(rawSettings)) {
    return {
      integrationProvider: 'garage_hive',
      garageHiveSettings: createDefaultGarageHiveSettings(),
      tyresoftSettings: createDefaultTyresoftSettings(),
    };
  }

  const settingsRecord = rawSettings as Record<string, unknown>;

  return {
    integrationProvider: 'garage_hive',
    garageHiveSettings: cloneGarageHiveSettings({
      instanceUrl: typeof settingsRecord.instanceUrl === 'string' ? settingsRecord.instanceUrl : '',
      apiKey: typeof settingsRecord.apiKey === 'string' ? settingsRecord.apiKey : '',
      customerId: typeof settingsRecord.customerId === 'string' ? settingsRecord.customerId : '',
      locationId: typeof settingsRecord.locationId === 'string' ? settingsRecord.locationId : '',
    }),
    tyresoftSettings: createDefaultTyresoftSettings(),
  };
};

const defaultConfiguration: AgentConfigurationPayload = {
  branchName: '',
  phoneNumber: '',
  emailAddress: '',
  branchAddress: '',
  websiteUrl: '',
  weeklyOpeningHours: createDefaultWeeklyOpeningHours(),
  holidayClosures: '',
  greetingLine: '',
  tonePreference: 'standard' as const,
  responseSpeed: 'normal',
  interruptionSensitivity: 0.5,
  allowFastFitOnly: false,
  notificationEmails: [],
  integrationProvider: 'none',
  garageHiveSettings: createDefaultGarageHiveSettings(),
  agentType: 'assist',
  enableSmsBookingLinks: true,
  allowBookings: false,
  bookingLeadTimeDays: 1,
  voice: 'leah',
};
const sanitizeConfigForResponse = (config: AgentConfigurationPayload) => {
  const weeklyOpeningHours = config.weeklyOpeningHours
    ? cloneWeeklyOpeningHours(config.weeklyOpeningHours)
    : createDefaultWeeklyOpeningHours();
  const sanitizedProvider: IntegrationProvider = config.integrationProvider === 'garage_hive' ? 'garage_hive' : 'none';
  const garageHiveSettings = sanitizedProvider === 'garage_hive'
    ? cloneGarageHiveSettings(config.garageHiveSettings)
    : createDefaultGarageHiveSettings();

  return {
    ...config,
    phoneNumber: config.phoneNumber ?? '',
    emailAddress: config.emailAddress ?? '',
    branchAddress: config.branchAddress ?? '',
    websiteUrl: config.websiteUrl ?? '',
    weeklyOpeningHours,
    holidayClosures: config.holidayClosures ?? '',
    greetingLine: config.greetingLine ?? '',
    responseSpeed: config.responseSpeed ?? 'normal',
    interruptionSensitivity:
      typeof config.interruptionSensitivity === 'number'
        ? Math.min(1, Math.max(0, config.interruptionSensitivity))
        : 0.5,
    allowFastFitOnly: config.allowFastFitOnly ?? false,
    enableDropOffBookings: config.enableDropOffBookings ?? false,
    dropOffMessage: config.dropOffMessage ?? 'drop your vehicle off between 8am and half ten in the morning',
    dropOffExcludeServices: config.dropOffExcludeServices ?? ['MOT'],
    notificationEmails: Array.isArray(config.notificationEmails) ? config.notificationEmails : [],
    integrationProvider: sanitizedProvider,
    garageHiveSettings,
    agentType: config.agentType === 'automate' ? 'automate' : 'assist',
    agentScript: 
      config.agentScript === 'tyresoft-agent' ? 'tyresoft-agent' :
      config.agentScript === 'receptionmate-agent-v3' ? 'receptionmate-agent-v3' :
      (config.agentScript as any) === 'Newreceptionmateagent.py' ? 'receptionmate-agent-v3' :
      (config.agentScript as any) === 'basic_agent2.py' ? 'receptionmate-agent' :
      'receptionmate-agent',
    enableSmsBookingLinks: config.enableSmsBookingLinks ?? true,
    allowBookings: config.allowBookings ?? false,
    bookingLeadTimeDays: config.bookingLeadTimeDays ?? 1,
    voice: config.voice ?? 'leah',
  };
};

const buildConfigurationResponse = (configuration: PrismaAgentConfiguration | null) => {
  if (!configuration) {
    return sanitizeConfigForResponse(defaultConfiguration);
  }

  return sanitizeConfigForResponse({
    branchName: configuration.branchName,
    phoneNumber: configuration.phoneNumber,
    emailAddress: configuration.emailAddress,
    branchAddress: configuration.branchAddress,
    websiteUrl: configuration.websiteUrl,
    weeklyOpeningHours: parseWeeklyOpeningHours(configuration.weeklyOpeningHours),
    holidayClosures: configuration.holidayClosures,
    greetingLine: configuration.greetingLine,
    tonePreference: (configuration.tonePreference || 'standard') as 'standard' | 'upbeat' | 'professional',
    responseSpeed: (configuration.responseSpeed || 'normal') as ResponseSpeed,
    interruptionSensitivity:
      typeof configuration.interruptionSensitivity === 'number'
        ? Math.min(1, Math.max(0, configuration.interruptionSensitivity))
        : 0.5,
    allowFastFitOnly: configuration.allowFastFitOnly,
    enableDropOffBookings: configuration.enableDropOffBookings || false,
    dropOffMessage: configuration.dropOffMessage || 'drop your vehicle off between 8am and half ten in the morning',
    dropOffExcludeServices: configuration.dropOffExcludeServices || ['MOT'],
    notificationEmails: configuration.notificationEmails || [],
    agentType: (configuration.agentType === 'automate' ? 'automate' : 'assist') as 'assist' | 'automate',
    enableSmsBookingLinks: configuration.enableSmsBookingLinks !== false,
    allowBookings: configuration.allowBookings || false,
    bookingLeadTimeDays: configuration.bookingLeadTimeDays || 1,
    voice: (['tom', 'leah', 'sophie', 'gemma', 'isobel', 'fraser', 'amelia'].includes(configuration.voice) ? configuration.voice : 'leah') as 'tom' | 'leah' | 'sophie' | 'gemma' | 'isobel' | 'fraser' | 'amelia',
    agentScript: (
      configuration.agentScript === 'tyresoft-agent' ? 'tyresoft-agent' :
      configuration.agentScript === 'receptionmate-agent-v3' ? 'receptionmate-agent-v3' :
      (configuration.agentScript as any) === 'Newreceptionmateagent.py' ? 'receptionmate-agent-v3' :
      (configuration.agentScript as any) === 'basic_agent2.py' ? 'receptionmate-agent' :
      'receptionmate-agent'
    ),
    ...parseIntegrationSettings(
      configuration.integrationProvider,
      configuration.integrationProviderConfig,
      configuration.agentScript,
    ),
  });
};

const serializeKnowledgeDocument = (document: PrismaKnowledgeDocument) => ({
  id: document.id,
  source: document.source,
  title: document.title ?? null,
  url: document.url ?? null,
  content: document.content,
  metadata: document.metadata ?? null,
  createdAt: document.createdAt.toISOString(),
  updatedAt: document.updatedAt.toISOString(),
});

type SerializedKnowledgeDocument = ReturnType<typeof serializeKnowledgeDocument>;

const loadKnowledgeBase = async (garageId: string): Promise<SerializedKnowledgeDocument[]> => {
  const documents = await prisma.agentKnowledgeDocument.findMany({
    where: { garageId },
    orderBy: [{ createdAt: 'asc' }],
  });
  return documents.map(serializeKnowledgeDocument);
};

type KnowledgeDocumentSeed = {
  title: string | null;
  content: string;
  metadata: Record<string, unknown>;
};

const buildKnowledgeFromPages = (pages: WebsitePageAnalysis[]): KnowledgeDocumentSeed[] => {
  if (pages.length === 0) {
    return [];
  }

  const extractedAt = new Date().toISOString();
  const origin = new URL(pages[0].url).origin;
  const phoneNumbers = new Set<string>();
  const emails = new Set<string>();
  const hours = new Set<string>();
  const addresses = new Set<string>();
  const descriptions = new Set<string>();

  const documents: KnowledgeDocumentSeed[] = [];

  pages.forEach((page) => {
    page.phoneNumbers.forEach((value) => phoneNumbers.add(value));
    page.emails.forEach((value) => emails.add(value));
    page.hours.forEach((value) => hours.add(value));
    if (page.address) {
      addresses.add(page.address);
    }
    if (page.description) {
      descriptions.add(page.description);
    }
  });

  const summaryLines: string[] = [];
  summaryLines.push(`Pages included (${pages.length}):`);
  pages.forEach((page) => {
    const pageTitle = page.title?.trim() || page.url;
    summaryLines.push(`- ${pageTitle} — ${page.url}`);
  });

  if (addresses.size > 0) {
    summaryLines.push(`Addresses: ${Array.from(addresses).join(' | ')}`);
  }
  if (phoneNumbers.size > 0) {
    summaryLines.push(`Phone numbers: ${Array.from(phoneNumbers).join(', ')}`);
  }
  if (emails.size > 0) {
    summaryLines.push(`Email contacts: ${Array.from(emails).join(', ')}`);
  }
  if (hours.size > 0) {
    summaryLines.push(`Published opening hours: ${Array.from(hours).join(' | ')}`);
  }
  if (descriptions.size > 0) {
    summaryLines.push(`Descriptions: ${Array.from(descriptions).join(' | ')}`);
  }
  summaryLines.push(`Extracted at: ${extractedAt}`);

  const primaryTitle = pages[0].title ?? new URL(pages[0].url).hostname;

  documents.push({
    title: primaryTitle,
    content: summaryLines.join('\n'),
    metadata: {
      origin,
      kind: 'summary',
      extractedAt,
      urls: pages.map((page) => page.url),
    },
  });

  const ensureDocument = (
    content: string | undefined,
    metadata: Record<string, unknown>,
    title: string | null,
  ) => {
    const trimmed = content?.trim();
    if (!trimmed || trimmed.length < 40) {
      return;
    }
    documents.push({
      title,
      content: trimmed,
      metadata,
    });
  };

  pages.forEach((page, pageIndex) => {
    if (page.knowledgeChunks.length > 0) {
      page.knowledgeChunks.forEach((chunk, chunkIndex) => {
        ensureDocument(chunk, {
          kind: 'chunk',
          origin,
          url: page.url,
          pageIndex,
          chunkIndex,
          extractedAt,
        }, `${page.title ?? 'Website details'} (section ${chunkIndex + 1})`);
      });
      return;
    }

    ensureDocument(
      page.description,
      {
        kind: 'page-summary',
        origin,
        url: page.url,
        pageIndex,
        extractedAt,
      },
      `${page.title ?? 'Website details'} — overview`,
    );

    ensureDocument(
      page.rawSnippet,
      {
        kind: 'page-snippet',
        origin,
        url: page.url,
        pageIndex,
        extractedAt,
      },
      `${page.title ?? 'Website details'} — snippet`,
    );
  });

  return documents;
};

const persistWebsiteKnowledge = async (
  garageId: string,
  pages: WebsitePageAnalysis[],
): Promise<SerializedKnowledgeDocument[]> => {
  const seeds = buildKnowledgeFromPages(pages);

  await prisma.agentKnowledgeDocument.deleteMany({
    where: { garageId, source: WEBSITE_KNOWLEDGE_SOURCE },
  });

  if (seeds.length === 0) {
    return loadKnowledgeBase(garageId);
  }

  await prisma.$transaction(
    seeds.map((seed, index) =>
      prisma.agentKnowledgeDocument.create({
        data: {
          garageId,
          source: WEBSITE_KNOWLEDGE_SOURCE,
          title: seed.title,
          url:
            (() => {
              const candidate = (seed.metadata as { url?: unknown }).url;
              return typeof candidate === 'string' ? candidate : null;
            })(),
          content: seed.content,
          metadata: {
            ...seed.metadata,
            chunkIndex: index,
          } as Prisma.JsonObject,
        },
      }),
    ),
  );

  return loadKnowledgeBase(garageId);
};

router.get(
  '/garages/:garageId/agent-config',
  authenticate,
  requireManager,
  async (req: Request, res: Response) => {
    const { garageId } = req.params;
    const allowedGarages = resolveAllowedGarages(req.user);

    if (!allowedGarages.includes(garageId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const [configurationRecord, garageRecord] = await Promise.all([
      prisma.agentConfiguration.findUnique({
        where: { garageId },
      }),
      prisma.garage.findUnique({
        where: { id: garageId },
        select: { twilioNumber: true },
      }),
    ]);

    const configuration = buildConfigurationResponse(configurationRecord);
    console.log('[GET_AGENT_CONFIG] Raw agentScript from DB:', configurationRecord?.agentScript);
    console.log('[GET_AGENT_CONFIG] Normalized agentScript:', configuration.agentScript);
    const knowledgeBase = await loadKnowledgeBase(garageId);

    return res.json({
      configuration,
      knowledgeBase,
      twilioNumber: garageRecord?.twilioNumber ?? null,
    });
  },
);

const sendAgentConfigWebhook = async (garageId: string) => {
  const webhookUrl = process.env.AGENT_CONFIG_WEBHOOK_URL;
  if (!webhookUrl) {
    return;
  }

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (process.env.AGENT_CONFIG_WEBHOOK_SECRET) {
      headers['x-agent-config-secret'] = process.env.AGENT_CONFIG_WEBHOOK_SECRET;
    }

    const [configurationRecord, garageRecord] = await Promise.all([
      prisma.agentConfiguration.findUnique({ where: { garageId } }),
      prisma.garage.findUnique({
        where: { id: garageId },
        select: { twilioNumber: true },
      }),
    ]);
    const configuration = buildConfigurationResponse(configurationRecord);
    const knowledgeBase = await loadKnowledgeBase(garageId);
    const knowledgeVersion = knowledgeBase.reduce<string | null>((latest, doc) => {
      const candidate = doc.updatedAt;
      if (!candidate) {
        return latest;
      }
      if (!latest) {
        return candidate;
      }
      return candidate > latest ? candidate : latest;
    }, null);

    console.log('[WEBHOOK] Sending configuration for garage:', garageId);
    console.log('[WEBHOOK] agentType in configuration:', configuration.agentType);
    console.log('[WEBHOOK] Full configuration:', JSON.stringify(configuration, null, 2));

    await fetch(webhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        garageId,
        twilioNumber: garageRecord?.twilioNumber ?? null,
        configuration,
        knowledgeBase,
        knowledgeVersion,
      }),
    });
  } catch (error) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('Failed to send agent configuration webhook', error);
    }
  }
};

const updateSipDispatchRule = async (garageId: string, agentScript: 'receptionmate-agent' | 'receptionmate-agent-v3' | 'tyresoft-agent') => {
  const onboardingUrl = process.env.ONBOARDING_SERVICE_URL;
  if (!onboardingUrl) {
    console.log('[UPDATE_SIP] No onboarding service URL configured');
    return;
  }

  try {
    const agentName = agentScript;

    const onboardingSecret = process.env.ONBOARDING_SECRET;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (onboardingSecret) {
      headers['x-onboarding-secret'] = onboardingSecret;
    }

    console.log(`[UPDATE_SIP] Updating dispatch rule for garage ${garageId} to agent: ${agentName}`);

    await fetch(`${onboardingUrl}/update-agent`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        garageId,
        agentName,
      }),
    });
  } catch (error) {
    console.error('[UPDATE_SIP] Failed to update SIP dispatch rule:', error);
  }
};

router.put(
  '/garages/:garageId/agent-config',
  authenticate,
  requireManager,
  async (req: Request, res: Response) => {
    const { garageId } = req.params;
    const allowedGarages = resolveAllowedGarages(req.user);

    if (!allowedGarages.includes(garageId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Migrate old agentScript values before validation
    if (req.body.agentScript === 'Newreceptionmateagent.py') {
      console.log('[MIGRATION] Converting Newreceptionmateagent.py -> receptionmate-agent-v3');
      req.body.agentScript = 'receptionmate-agent-v3';
    } else if (req.body.agentScript === 'basic_agent2.py') {
      console.log('[MIGRATION] Converting basic_agent2.py -> receptionmate-agent');
      req.body.agentScript = 'receptionmate-agent';
    }

    // Log drop-off booking fields from request
    console.log('[AGENT_CONFIG_UPDATE] Drop-off fields received:', {
      enableDropOffBookings: req.body.enableDropOffBookings,
      dropOffMessage: req.body.dropOffMessage,
      dropOffExcludeServices: req.body.dropOffExcludeServices
    });

    const parseResult = upsertAgentConfigurationSchema.safeParse(req.body);

    if (!parseResult.success) {
      console.log('[VALIDATION ERROR] Request body:', JSON.stringify(req.body, null, 2));
      console.log('[VALIDATION ERROR] Errors:', JSON.stringify(parseResult.error.flatten(), null, 2));
      return res.status(400).json({ error: parseResult.error.flatten() });
    }

    const data = parseResult.data;
    const canEditAgentType = req.user?.role === 'RECEPTIONMATE_STAFF';
    let resolvedAgentType: 'assist' | 'automate' = data.agentType === 'automate' ? 'automate' : 'assist';
    let resolvedAgentScript: 'receptionmate-agent' | 'receptionmate-agent-v3' | 'tyresoft-agent' = data.agentScript === 'tyresoft-agent' ? 'tyresoft-agent' : data.agentScript === 'receptionmate-agent-v3' ? 'receptionmate-agent-v3' : 'receptionmate-agent';

    if (!canEditAgentType) {
      const existingConfig = await prisma.agentConfiguration.findUnique({
        where: { garageId },
        select: { agentType: true, agentScript: true },
      });
      resolvedAgentType = existingConfig?.agentType === 'automate' ? 'automate' : 'assist';
      resolvedAgentScript = existingConfig?.agentScript === 'tyresoft-agent' ? 'tyresoft-agent' : existingConfig?.agentScript === 'receptionmate-agent-v3' ? 'receptionmate-agent-v3' : 'receptionmate-agent';
    }

    const normalizedWeeklyOpeningHours = data.weeklyOpeningHours
      ? cloneWeeklyOpeningHours(data.weeklyOpeningHours)
      : createDefaultWeeklyOpeningHours();

    const requestedProvider: IntegrationProvider = data.integrationProvider === 'garage_hive' ? 'garage_hive' : 'none';
    const rawGarageHive = data.garageHiveSettings ?? {};
    const garageHiveSettings = requestedProvider === 'garage_hive'
      ? cloneGarageHiveSettings({
          instanceUrl:
            typeof rawGarageHive.instanceUrl === 'string' ? rawGarageHive.instanceUrl.trim() : '',
          apiKey:
            typeof rawGarageHive.apiKey === 'string' ? rawGarageHive.apiKey.trim() : '',
          customerId:
            typeof rawGarageHive.customerId === 'string' ? rawGarageHive.customerId.trim() : '',
          locationId:
            typeof rawGarageHive.locationId === 'string' ? rawGarageHive.locationId.trim() : '',
        })
      : createDefaultGarageHiveSettings();

    const existingConfig = await prisma.agentConfiguration.findUnique({
      where: { garageId },
      select: { agentScript: true, integrationProviderConfig: true },
    });

    const rawTyresoft = data.tyresoftSettings ?? {};
    // Tyresoft takes priority — if agentScript is tyresoft-agent and credentials provided, store them.
    // If credentials are not provided in this save, fall back to existing saved config to avoid wiping it.
    const integrationProviderConfig: Prisma.InputJsonValue | null =
      resolvedAgentScript === 'tyresoft-agent' && rawTyresoft.tsWorkspace
        ? {
            tsWorkspace: typeof rawTyresoft.tsWorkspace === 'string' ? rawTyresoft.tsWorkspace.trim() : '',
            tsUsername: typeof rawTyresoft.tsUsername === 'string' ? rawTyresoft.tsUsername.trim() : '',
            tsPassword: typeof rawTyresoft.tsPassword === 'string' ? rawTyresoft.tsPassword.trim() : '',
            tsApiKey: typeof rawTyresoft.tsApiKey === 'string' ? rawTyresoft.tsApiKey.trim() : '',
            tsDepotId: rawTyresoft.tsDepotId != null ? Number(rawTyresoft.tsDepotId) : 1,
          }
        : resolvedAgentScript === 'tyresoft-agent' && existingConfig?.integrationProviderConfig
        ? existingConfig.integrationProviderConfig as Prisma.InputJsonValue
        : requestedProvider === 'garage_hive'
        ? {
            instanceUrl: garageHiveSettings.instanceUrl,
            apiKey: garageHiveSettings.apiKey,
            customerId: garageHiveSettings.customerId,
            locationId: garageHiveSettings.locationId,
          }
        : null;

    const normalizedData = {
      branchName: data.branchName,
      phoneNumber: data.phoneNumber || null,
      emailAddress: data.emailAddress || null,
      branchAddress: data.branchAddress || null,
      websiteUrl: data.websiteUrl || null,
      weeklyOpeningHours: normalizedWeeklyOpeningHours,
      holidayClosures: data.holidayClosures || null,
      greetingLine: data.greetingLine || null,
      tonePreference: data.tonePreference,
      responseSpeed: (data.responseSpeed || 'normal') as ResponseSpeed,
      interruptionSensitivity:
        typeof data.interruptionSensitivity === 'number'
          ? Math.min(1, Math.max(0, data.interruptionSensitivity))
          : 0.5,
      allowFastFitOnly: data.allowFastFitOnly,
      enableDropOffBookings: data.enableDropOffBookings || false,
      dropOffMessage: data.dropOffMessage || 'drop your vehicle off between 8am and half ten in the morning',
      dropOffExcludeServices: data.dropOffExcludeServices || ['MOT'],
      notificationEmails: data.notificationEmails || [],
      integrationProvider: requestedProvider,
      integrationProviderConfig: integrationProviderConfig || undefined,
      agentType: resolvedAgentType,
      agentScript: resolvedAgentScript,
      enableSmsBookingLinks: data.enableSmsBookingLinks !== false,
      allowBookings: data.allowBookings ?? false,
      bookingLeadTimeDays: data.bookingLeadTimeDays ?? 1,
      voice: data.voice || 'leah',
    };

    const [configuration, garageRecord] = await Promise.all([
      prisma.agentConfiguration.upsert({
        where: { garageId },
        update: normalizedData,
        create: {
          garageId,
          ...normalizedData,
        },
      }),
      prisma.garage.findUnique({
        where: { id: garageId },
        select: { twilioNumber: true },
      }),
    ]);

    void sendAgentConfigWebhook(garageId);

    // If agentScript changed and garage has Twilio number, update SIP dispatch rule
    console.log('[UPDATE_AGENT] Checking dispatch rule update:', {
      garageId,
      existingAgentScript: existingConfig?.agentScript,
      newAgentScript: resolvedAgentScript,
      hasChanged: existingConfig?.agentScript !== resolvedAgentScript,
      hasTwilioNumber: !!garageRecord?.twilioNumber,
      twilioNumber: garageRecord?.twilioNumber
    });
    
    if (existingConfig && existingConfig.agentScript !== resolvedAgentScript && garageRecord?.twilioNumber) {
      console.log('[UPDATE_AGENT] Updating SIP dispatch rule for garage', garageId, 'to agent:', resolvedAgentScript);
      void updateSipDispatchRule(garageId, resolvedAgentScript);
    } else {
      console.log('[UPDATE_AGENT] Skipping dispatch rule update - conditions not met');
    }

    const knowledgeBase = await loadKnowledgeBase(garageId);

    return res.json({
      configuration: buildConfigurationResponse(configuration),
      knowledgeBase,
      twilioNumber: garageRecord?.twilioNumber ?? null,
    });
  },
);

router.post(
  '/garages/:garageId/website-scan',
  authenticate,
  async (req: Request, res: Response) => {
    const { garageId } = req.params;
    const allowedGarages = resolveAllowedGarages(req.user);

    if (!allowedGarages.includes(garageId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const parseResult = websiteScanSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({ error: parseResult.error.flatten() });
    }

    const { url, selectedUrls } = parseResult.data;

    try {
      if (!selectedUrls) {
        const discovery = await discoverWebsitePages(url);
        return res.json(discovery);
      }

      const sanitizedSelection = sanitiseSelectedUrls(url, selectedUrls);
      if (sanitizedSelection.length === 0) {
        return res.status(400).json({ error: 'No valid pages selected' });
      }

      const pages: WebsitePageAnalysis[] = [];
      for (const candidate of sanitizedSelection) {
        try {
          const page = await scrapeWebsitePage(candidate);
          pages.push(page);
        } catch (error) {
          if (process.env.NODE_ENV !== 'production') {
            console.error(`Failed to analyse page ${candidate}`, error);
          }
        }
      }

      if (pages.length === 0) {
        return res.status(502).json({ error: 'Failed to analyse selected pages' });
      }

      const knowledgeBase = await persistWebsiteKnowledge(garageId, pages);

      void sendAgentConfigWebhook(garageId);

      return res.json({ knowledgeBase, processedPages: pages.length });
    } catch (error) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('Website scan failed', error);
      }
      return res.status(502).json({ error: 'Failed to analyse website' });
    }
  },
);

export default router;
