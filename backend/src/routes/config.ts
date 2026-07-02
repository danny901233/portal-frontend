import type { AgentConfiguration as PrismaAgentConfiguration, AgentKnowledgeDocument as PrismaKnowledgeDocument } from '@prisma/client';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { Router } from 'express';
import { prisma } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { requireManagerLive } from '../middleware/auth.js';
import { resolveAllowedGarages } from '../utils/auth.js';
import { upsertAgentConfigurationSchema, weeklyOpeningHoursSchema, websiteScanSchema } from '../utils/validators.js';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import {
  extractTextFromFile,
  chunkText,
  isSupportedUpload,
  fileExt,
  MAX_UPLOAD_BYTES,
  type KnowledgeKind,
} from '../utils/knowledgeUpload.js';
// The backend runs as ESM, where `require` is undefined — so getDynamoClient()'s
// require('@aws-sdk/client-dynamodb') was throwing and the DynamoDB config sync silently no-op'd.
// Same createRequire shim used in payment.ts / billing-activation.ts.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import {
  cloneGarageHiveSettings,
  cloneHubspotSettings,
  cloneTyresoftSettings,
  cloneWeeklyOpeningHours,
  createDefaultGarageHiveSettings,
  createDefaultHubspotSettings,
  createDefaultTyresoftSettings,
  createDefaultWeeklyOpeningHours,
} from '../utils/types.js';
import type {
  AgentConfigurationPayload,
  GarageHiveSettings,
  HubspotSettings,
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
          // Per-garage Tyresoft client channel id — the agent reads this off the
          // DynamoDB tyresoftSettings (this object IS what's synced there) and sends
          // it on createSale. Also surfaced so the portal editor can show/edit it.
          tsChannelId: raw.tsChannelId != null ? String(raw.tsChannelId) : '',
          // Structured pricing data (per-service catalogue + engine-size brackets) lives in the same
          // integrationProviderConfig JSON. Forward to the frontend so the Tyresoft pricing editor
          // can read + edit it.
          tsServices: Array.isArray(raw.tsServices) ? (raw.tsServices as TyresoftSettings['tsServices']) : undefined,
          pricingRules:
            raw.pricingRules && typeof raw.pricingRules === 'object' && !Array.isArray(raw.pricingRules)
              ? (raw.pricingRules as TyresoftSettings['pricingRules'])
              : undefined,
          tsServicesUpload:
            raw.tsServicesUpload && typeof raw.tsServicesUpload === 'object' && !Array.isArray(raw.tsServicesUpload)
              ? (raw.tsServicesUpload as TyresoftSettings['tsServicesUpload'])
              : undefined,
          // Derive form-friendly { type, value } from whichever numeric markup
          // field is set on integrationProviderConfig (top-level — where the
          // agent reads). PERCENT wins over FLAT if both are somehow present,
          // mirroring agent.py's preference.
          ...(typeof raw.tyreMarkupPercent === 'number'
            ? { tyreMarkupType: 'percent' as const, tyreMarkupValue: String(raw.tyreMarkupPercent) }
            : typeof raw.tyreMarkupFlat === 'number'
              ? { tyreMarkupType: 'flat' as const, tyreMarkupValue: String(raw.tyreMarkupFlat) }
              : {}),
          // Also surface the numeric fields the deployed agent actually reads
          // (agent.py:1217-1228 falls back to tyresoftSettings.tyreMarkupFlat /
          // tyreMarkupPercent if integrationProviderConfig.* isn't found). The
          // DynamoDB sync ships THIS object, so we need both shapes here.
          ...(typeof raw.tyreMarkupFlat === 'number' ? { tyreMarkupFlat: raw.tyreMarkupFlat } : {}),
          ...(typeof raw.tyreMarkupPercent === 'number' ? { tyreMarkupPercent: raw.tyreMarkupPercent } : {}),
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

  // Support both flat structure { instanceUrl, apiKey, ... }
  // and nested structure { garagehive: { instanceUrl, apiKey, ... } }
  const ghRecord =
    typeof settingsRecord.garagehive === 'object' && settingsRecord.garagehive !== null
      ? (settingsRecord.garagehive as Record<string, unknown>)
      : settingsRecord;

  return {
    integrationProvider: 'garage_hive',
    garageHiveSettings: cloneGarageHiveSettings({
      instanceUrl: typeof ghRecord.instanceUrl === 'string' ? ghRecord.instanceUrl : '',
      apiKey: typeof ghRecord.apiKey === 'string' ? ghRecord.apiKey : '',
      customerId: typeof ghRecord.customerId === 'string' ? ghRecord.customerId : '',
      locationId: typeof ghRecord.locationId === 'string' ? ghRecord.locationId : '',
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
  humanEscalation: true,
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
      config.agentScript === 'Assist-agent' ? 'Assist-agent' :
      config.agentScript === 'GarageHive-agent' ? 'GarageHive-agent' :
      config.agentScript === 'MMH-agent' ? 'MMH-agent' :
      (config.agentScript as any) === 'Newreceptionmateagent.py' ? 'receptionmate-agent-v3' :
      (config.agentScript as any) === 'basic_agent2.py' ? 'receptionmate-agent' :
      'receptionmate-agent',
    enableSmsBookingLinks: config.enableSmsBookingLinks ?? true,
    humanEscalation: config.humanEscalation ?? true,
    allowBookings: config.allowBookings ?? false,
    bookingLeadTimeDays: config.bookingLeadTimeDays ?? 1,
    voice: config.voice ?? 'leah',
  };
};

// Fields the sanitized payload doesn't carry on its own but the agent needs: custom
// rules, smart questions, FAQs, pronunciations and the transfer number. Forward them
// verbatim so they reach the runtime config (DynamoDB) the agent reads.
const extraAgentFields = (configuration: PrismaAgentConfiguration | null) => {
  const c = (configuration ?? {}) as Record<string, unknown>;
  return {
    agentName: c.agentName ?? '',
    customRules: c.customRules ?? [],
    dataCollectionFields: c.dataCollectionFields ?? [],
    faqs: c.faqs ?? [],
    pronunciations: c.pronunciations ?? [],
    transferNumber: c.transferNumber ?? '',
  };
};

const buildConfigurationResponse = (configuration: PrismaAgentConfiguration | null) => {
  if (!configuration) {
    return { ...sanitizeConfigForResponse(defaultConfiguration), ...extraAgentFields(null) };
  }

  return { ...sanitizeConfigForResponse({
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
    humanEscalation: (configuration as Record<string, unknown>).humanEscalation !== false,
    allowBookings: configuration.allowBookings || false,
    bookingLeadTimeDays: configuration.bookingLeadTimeDays || 1,
    voice: (['tom', 'leah', 'sophie', 'gemma', 'isobel', 'fraser', 'amelia'].includes(configuration.voice) ? configuration.voice : 'leah') as 'tom' | 'leah' | 'sophie' | 'gemma' | 'isobel' | 'fraser' | 'amelia',
    agentScript: (
      configuration.agentScript === 'tyresoft-agent' ? 'tyresoft-agent' :
      configuration.agentScript === 'receptionmate-agent-v3' ? 'receptionmate-agent-v3' :
      configuration.agentScript === 'Assist-agent' ? 'Assist-agent' :
      configuration.agentScript === 'GarageHive-agent' ? 'GarageHive-agent' :
      configuration.agentScript === 'MMH-agent' ? 'MMH-agent' :
      (configuration.agentScript as any) === 'Newreceptionmateagent.py' ? 'receptionmate-agent-v3' :
      (configuration.agentScript as any) === 'basic_agent2.py' ? 'receptionmate-agent' :
      'receptionmate-agent'
    ),
    ...parseIntegrationSettings(
      configuration.integrationProvider,
      configuration.integrationProviderConfig,
      configuration.agentScript,
    ),
    hubspotSettings: (() => {
      const raw = configuration.integrationProviderConfig;
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const cfg = raw as Record<string, unknown>;
        if (cfg.hubspot && typeof cfg.hubspot === 'object' && !Array.isArray(cfg.hubspot)) {
          return cloneHubspotSettings(cfg.hubspot as HubspotSettings);
        }
      }
      return createDefaultHubspotSettings();
    })(),
  }), ...extraAgentFields(configuration) };
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
  requireManagerLive,
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

// Direct write of the runtime config the agent reads (DynamoDB AgentConfig), so config
// syncs don't depend on the external webhook Lambda (which has been returning 500).
// Mirrors the write in routes/agentWebhook.ts.
let dynamoClientCache: { client: any; PutItemCommand: any } | false | null = null;
const getDynamoClient = () => {
  if (dynamoClientCache !== null) {
    return dynamoClientCache || null;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DynamoDBClient, PutItemCommand } = require('@aws-sdk/client-dynamodb');
    const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'eu-west-2';
    // Pass creds EXPLICITLY from env. The SDK's default provider chain was failing in this process
    // ("could not load credentials") even though dotenv had loaded AWS_ACCESS_KEY_ID/SECRET — passing
    // them directly removes that ambiguity.
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    const clientConfig: { region: string; credentials?: { accessKeyId: string; secretAccessKey: string } } = { region };
    if (accessKeyId && secretAccessKey) {
      clientConfig.credentials = { accessKeyId, secretAccessKey };
    }
    console.log(`[SYNC] dynamo client init — explicit creds present: ${Boolean(accessKeyId && secretAccessKey)}, region: ${region}`);
    dynamoClientCache = { client: new DynamoDBClient(clientConfig), PutItemCommand };
  } catch (error) {
    console.error('[SYNC] DynamoDB client unavailable', error);
    dynamoClientCache = false;
  }
  return dynamoClientCache || null;
};

const writeAgentConfigToDynamo = async (
  garageId: string,
  configuration: unknown,
  knowledgeBase: unknown[],
  knowledgeVersion: string | null,
) => {
  const dynamo = getDynamoClient();
  if (!dynamo) {
    return;
  }
  try {
    await dynamo.client.send(new dynamo.PutItemCommand({
      TableName: 'AgentConfig',
      Item: {
        garageId: { S: garageId },
        updatedAt: { S: new Date().toISOString() },
        configuration: { S: JSON.stringify(configuration) },
        knowledgeBase: { S: JSON.stringify(knowledgeBase ?? []) },
        knowledgeVersion: knowledgeVersion ? { S: knowledgeVersion } : { NULL: true },
      },
    }));
    console.log('[SYNC] DynamoDB AgentConfig updated directly for', garageId);
  } catch (error) {
    console.error('[SYNC] Direct DynamoDB write failed for', garageId, error);
  }
};

const sendAgentConfigWebhook = async (garageId: string) => {
  try {
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

    // Legacy webhook Lambda FIRST, best-effort. It's been returning 500 and writing an EMPTY
    // knowledgeBase, so it must run BEFORE the direct write below — otherwise it clobbers it.
    const webhookUrl = process.env.AGENT_CONFIG_WEBHOOK_URL;
    if (webhookUrl) {
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (process.env.AGENT_CONFIG_WEBHOOK_SECRET) {
          headers['x-agent-config-secret'] = process.env.AGENT_CONFIG_WEBHOOK_SECRET;
        }
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
      } catch (whErr) {
        console.error('[WEBHOOK] legacy Lambda call failed (non-fatal)', whErr);
      }
    }

    // AUTHORITATIVE: write the runtime config the agent reads, directly to DynamoDB, LAST so it wins.
    await writeAgentConfigToDynamo(garageId, configuration, knowledgeBase, knowledgeVersion);
  } catch (error) {
    console.error('[SYNC] Failed to sync agent configuration for', garageId, error);
  }
};

// Auto-ingest a garage's website into its knowledge base in the background (used at signup, so the
// agent can answer from the site without anyone clicking "Scan site"). Best-effort: never throws.
export const autoIngestWebsiteKnowledge = async (garageId: string, url: string): Promise<void> => {
  try {
    const discovery = await discoverWebsitePages(url);
    const candidateUrls = (discovery.pages ?? []).slice(0, 8).map((p) => p.url);
    if (candidateUrls.length === 0) {
      return;
    }
    const pages: WebsitePageAnalysis[] = [];
    for (const candidate of candidateUrls) {
      try {
        pages.push(await scrapeWebsitePage(candidate));
      } catch {
        /* skip a page that won't scrape */
      }
    }
    if (pages.length === 0) {
      return;
    }
    await persistWebsiteKnowledge(garageId, pages);
    await sendAgentConfigWebhook(garageId);
    console.log(`[SIGNUP_KB] auto-ingested ${pages.length} website page(s) into KB for garage=${garageId}`);
  } catch (error) {
    console.error('[SIGNUP_KB] website auto-ingest failed for garage', garageId, error);
  }
};

const updateSipDispatchRule = async (garageId: string, agentScript: 'receptionmate-agent' | 'receptionmate-agent-v3' | 'tyresoft-agent' | 'Assist-agent' | 'GarageHive-agent' | 'MMH-agent') => {
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
  requireManagerLive,
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
    let resolvedAgentScript: 'receptionmate-agent' | 'receptionmate-agent-v3' | 'tyresoft-agent' | 'Assist-agent' | 'GarageHive-agent' | 'MMH-agent' = data.agentScript === 'tyresoft-agent' ? 'tyresoft-agent' : data.agentScript === 'receptionmate-agent-v3' ? 'receptionmate-agent-v3' : data.agentScript === 'Assist-agent' ? 'Assist-agent' : data.agentScript === 'GarageHive-agent' ? 'GarageHive-agent' : data.agentScript === 'MMH-agent' ? 'MMH-agent' : 'receptionmate-agent';

    // Only staff can change which agent serves the garage; everyone else keeps the saved script.
    if (!canEditAgentType) {
      const existingConfig = await prisma.agentConfiguration.findUnique({
        where: { garageId },
        select: { agentScript: true },
      });
      resolvedAgentScript = existingConfig?.agentScript === 'tyresoft-agent' ? 'tyresoft-agent' : existingConfig?.agentScript === 'receptionmate-agent-v3' ? 'receptionmate-agent-v3' : existingConfig?.agentScript === 'Assist-agent' ? 'Assist-agent' : existingConfig?.agentScript === 'GarageHive-agent' ? 'GarageHive-agent' : existingConfig?.agentScript === 'MMH-agent' ? 'MMH-agent' : 'receptionmate-agent';
    }

    // agentType is DERIVED from the agent script — the script is the single source of truth.
    // Only the Assist agent is message-only; every other script books. Deriving it makes type and
    // script structurally unable to drift (drift previously mis-routed assist garages to a dead account).
    const resolvedAgentType: 'assist' | 'automate' = resolvedAgentScript === 'Assist-agent' ? 'assist' : 'automate';

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
    // Build hubspot sub-object to merge into integrationProviderConfig
    const hubspotPayload = data.hubspotSettings
      ? { hubspot: cloneHubspotSettings(data.hubspotSettings) }
      : (() => {
          // Preserve existing hubspot config if not provided in this request
          const existing = existingConfig?.integrationProviderConfig;
          if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
            const ex = existing as Record<string, unknown>;
            if (ex.hubspot) return { hubspot: ex.hubspot };
          }
          return {};
        })();

    // Pull structured pricing data off the incoming tyresoftSettings so we
    // can preserve / overlay it on both tyresoft save branches.
    // - If the request includes tsServices/pricingRules, those win.
    // - Otherwise we keep whatever's already saved on the row.
    const existingTsConfig =
      existingConfig?.integrationProviderConfig &&
      typeof existingConfig.integrationProviderConfig === 'object' &&
      !Array.isArray(existingConfig.integrationProviderConfig)
        ? (existingConfig.integrationProviderConfig as Record<string, unknown>)
        : undefined;
    const incomingTsServices =
      Array.isArray(rawTyresoft.tsServices) ? rawTyresoft.tsServices : undefined;
    const existingTsServices =
      Array.isArray(existingTsConfig?.tsServices) ? (existingTsConfig?.tsServices as unknown[]) : undefined;
    const tsServicesToSave = incomingTsServices ?? existingTsServices;
    const incomingPricingRules =
      rawTyresoft.pricingRules &&
      typeof rawTyresoft.pricingRules === 'object' &&
      !Array.isArray(rawTyresoft.pricingRules)
        ? rawTyresoft.pricingRules
        : undefined;
    const existingPricingRules =
      existingTsConfig?.pricingRules &&
      typeof existingTsConfig.pricingRules === 'object' &&
      !Array.isArray(existingTsConfig.pricingRules)
        ? (existingTsConfig.pricingRules as Record<string, unknown>)
        : undefined;
    const pricingRulesToSave = incomingPricingRules ?? existingPricingRules;
    // Carry the upload metadata forward too — saves through the with-creds
    // rebuild path would otherwise wipe it. The CSV upload endpoint writes
    // this; the form never sends it back, so always use existing.
    const existingTsServicesUpload =
      existingTsConfig?.tsServicesUpload &&
      typeof existingTsConfig.tsServicesUpload === 'object' &&
      !Array.isArray(existingTsConfig.tsServicesUpload)
        ? (existingTsConfig.tsServicesUpload as Record<string, unknown>)
        : undefined;
    // Per-garage tyre markup. Form sends form-friendly { tyreMarkupType,
    // tyreMarkupValue }. Persist BOTH the form fields (so the UI repopulates)
    // AND the numeric tyreMarkupFlat / tyreMarkupPercent (top-level, where
    // optimised-tyresoft/agent.py reads via _marked_price()). Empty value clears
    // both numeric fields. PERCENT branch sets only tyreMarkupPercent (clears
    // FLAT), FLAT branch sets only tyreMarkupFlat (clears PERCENT), matching
    // the agent's "percent wins over flat if both set" rule. If neither type/
    // value is in the request, preserve existing markup unchanged.
    const incomingMarkupType =
      rawTyresoft.tyreMarkupType === 'flat' || rawTyresoft.tyreMarkupType === 'percent'
        ? rawTyresoft.tyreMarkupType
        : undefined;
    const incomingMarkupValue =
      typeof rawTyresoft.tyreMarkupValue === 'string' ? rawTyresoft.tyreMarkupValue.trim() : undefined;
    const markupNumber =
      incomingMarkupValue && incomingMarkupValue !== ''
        ? Number.parseFloat(incomingMarkupValue)
        : NaN;
    let tyreMarkupPayload: Record<string, unknown>;
    if (incomingMarkupType !== undefined && incomingMarkupValue !== undefined) {
      // Form sent the markup fields — normalise.
      const validNumber = !Number.isNaN(markupNumber) && markupNumber >= 0;
      tyreMarkupPayload = {
        tyreMarkupType: incomingMarkupType,
        tyreMarkupValue: incomingMarkupValue,
        ...(validNumber && incomingMarkupType === 'flat'
          ? { tyreMarkupFlat: markupNumber, tyreMarkupPercent: null }
          : validNumber && incomingMarkupType === 'percent'
            ? { tyreMarkupPercent: markupNumber, tyreMarkupFlat: null }
            : { tyreMarkupFlat: null, tyreMarkupPercent: null }),
      };
    } else {
      // Form didn't touch markup — preserve whatever's already saved.
      tyreMarkupPayload = {
        ...(existingTsConfig?.tyreMarkupType !== undefined
          ? { tyreMarkupType: existingTsConfig.tyreMarkupType }
          : {}),
        ...(existingTsConfig?.tyreMarkupValue !== undefined
          ? { tyreMarkupValue: existingTsConfig.tyreMarkupValue }
          : {}),
        ...(typeof existingTsConfig?.tyreMarkupFlat === 'number'
          ? { tyreMarkupFlat: existingTsConfig.tyreMarkupFlat }
          : {}),
        ...(typeof existingTsConfig?.tyreMarkupPercent === 'number'
          ? { tyreMarkupPercent: existingTsConfig.tyreMarkupPercent }
          : {}),
      };
    }
    // Per-garage Tyresoft client channel id. The agent sends it on createSale;
    // an unset/wrong value makes Tyresoft reject the booking ("Invalid client
    // channel id"). Use the incoming value if the form sent one, else preserve
    // whatever's already stored (so unrelated saves don't wipe it).
    const incomingChannelId =
      rawTyresoft.tsChannelId != null && String(rawTyresoft.tsChannelId).trim() !== ''
        ? Number(rawTyresoft.tsChannelId)
        : undefined;
    const tsChannelPayload: Record<string, unknown> =
      incomingChannelId !== undefined && !Number.isNaN(incomingChannelId)
        ? { tsChannelId: incomingChannelId }
        : existingTsConfig?.tsChannelId !== undefined
        ? { tsChannelId: existingTsConfig.tsChannelId }
        : {};

    const tsStructuredPayload: Record<string, unknown> = {
      ...(tsServicesToSave !== undefined ? { tsServices: tsServicesToSave } : {}),
      ...(pricingRulesToSave !== undefined ? { pricingRules: pricingRulesToSave } : {}),
      ...(existingTsServicesUpload !== undefined
        ? { tsServicesUpload: existingTsServicesUpload }
        : {}),
      ...tsChannelPayload,
      ...tyreMarkupPayload,
    };

    const integrationProviderConfig: Prisma.InputJsonValue | null =
      resolvedAgentScript === 'tyresoft-agent' && rawTyresoft.tsWorkspace
        ? {
            tsWorkspace: typeof rawTyresoft.tsWorkspace === 'string' ? rawTyresoft.tsWorkspace.trim() : '',
            tsUsername: typeof rawTyresoft.tsUsername === 'string' ? rawTyresoft.tsUsername.trim() : '',
            tsPassword: typeof rawTyresoft.tsPassword === 'string' ? rawTyresoft.tsPassword.trim() : '',
            tsApiKey: typeof rawTyresoft.tsApiKey === 'string' ? rawTyresoft.tsApiKey.trim() : '',
            tsDepotId: rawTyresoft.tsDepotId != null ? Number(rawTyresoft.tsDepotId) : 1,
            ...tsStructuredPayload,
            ...hubspotPayload,
          }
        : resolvedAgentScript === 'tyresoft-agent' && existingConfig?.integrationProviderConfig
        ? {
            ...(existingConfig.integrationProviderConfig as object),
            ...tsStructuredPayload,
            ...hubspotPayload,
          }
        : requestedProvider === 'garage_hive'
        ? {
            instanceUrl: garageHiveSettings.instanceUrl,
            apiKey: garageHiveSettings.apiKey,
            customerId: garageHiveSettings.customerId,
            locationId: garageHiveSettings.locationId,
            ...hubspotPayload,
          }
        : Object.keys(hubspotPayload).length > 0 ? hubspotPayload : null;

    const normalizedData = {
      branchName: data.branchName,
      agentName: data.agentName || null,
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
      humanEscalation: data.humanEscalation !== false,
      allowBookings: data.allowBookings ?? false,
      bookingLeadTimeDays: data.bookingLeadTimeDays ?? 1,
      voice: data.voice || 'leah',
      // Previously dropped on write — now persisted so they save AND reach the agent.
      transferNumber: data.transferNumber || null,
      customRules: (data.customRules ?? []) as Prisma.InputJsonValue,
      dataCollectionFields: (data.dataCollectionFields ?? []) as Prisma.InputJsonValue,
      faqs: (data.faqs ?? []) as Prisma.InputJsonValue,
      pronunciations: (data.pronunciations ?? []) as Prisma.InputJsonValue,
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
    
    if (resolvedAgentScript === 'MMH-agent') {
      // MMH's SIP trunk + dispatch rule live in the dedicated 'new-gh-agent' LiveKit project,
      // which the onboarding service does NOT manage. Routing is handled entirely by voice.ts
      // (agentScript='MMH-agent' -> LIVEKIT_SIP_DOMAIN_MMH). Re-provisioning here would create a
      // stray/incorrect rule in the fleet project, so skip it.
      console.log('[UPDATE_AGENT] Skipping dispatch rule update for MMH-agent (routing via voice.ts to new-gh-agent project)');
    } else if (existingConfig && existingConfig.agentScript !== resolvedAgentScript && garageRecord?.twilioNumber) {
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

// ── Knowledge-base document upload (PDF / Word / CSV / Excel / text) ─────────────
// Parses the file to text, chunks it, stores the chunks as AgentKnowledgeDocument rows tagged
// with the upload's source ('document' or 'price-list'), then re-syncs the garage's runtime
// config to DynamoDB so the agent's search_knowledge() RAG can retrieve from it per-call.
const knowledgeUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES } });

// Wrap multer so a too-large/failed upload returns a clean 4xx instead of a generic 500.
const handleKnowledgeUpload = (req: Request, res: Response, next: () => void) => {
  knowledgeUpload.single('file')(req, res, (err: unknown) => {
    if (err) {
      const tooBig = typeof err === 'object' && err !== null && (err as { code?: string }).code === 'LIMIT_FILE_SIZE';
      return res.status(tooBig ? 413 : 400).json({
        error: tooBig ? 'File too large (max 10MB).' : 'Upload failed — please try again.',
      });
    }
    next();
  });
};

router.post(
  '/garages/:garageId/knowledge-upload',
  authenticate,
  requireManagerLive,
  handleKnowledgeUpload,
  async (req: Request, res: Response) => {
    const { garageId } = req.params;
    const allowedGarages = resolveAllowedGarages(req.user);
    if (!allowedGarages.includes(garageId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const file = (req as Request & { file?: { buffer: Buffer; originalname: string; size: number } }).file;
    if (!file) {
      return res.status(400).json({ error: 'No file uploaded.' });
    }
    if (!isSupportedUpload(file.originalname)) {
      return res.status(415).json({ error: 'Unsupported file type. Upload a PDF, Word, CSV, Excel, or text file.' });
    }

    const kind: KnowledgeKind = req.body?.kind === 'price-list' ? 'price-list' : 'document';

    let text = '';
    try {
      text = await extractTextFromFile(file.buffer, file.originalname);
    } catch (error) {
      console.error('[KNOWLEDGE_UPLOAD] parse failed', error);
      return res.status(422).json({ error: 'Could not read text from that file. Is it a scanned image?' });
    }
    const chunks = chunkText(text);
    if (chunks.length === 0) {
      return res.status(422).json({ error: 'No readable text found in that file.' });
    }

    const uploadId = randomUUID();
    const fileName = file.originalname;
    const fileType = fileExt(fileName);
    const uploadedAt = new Date().toISOString();
    const titleBase = kind === 'price-list' ? `Price list — ${fileName}` : fileName;

    await prisma.$transaction(
      chunks.map((content, index) =>
        prisma.agentKnowledgeDocument.create({
          data: {
            garageId,
            source: kind,
            title: chunks.length > 1 ? `${titleBase} (part ${index + 1}/${chunks.length})` : titleBase,
            url: null,
            content,
            metadata: {
              kind,
              uploadId,
              fileName,
              fileType,
              sizeBytes: file.size,
              uploadedAt,
              chunkIndex: index,
              totalChunks: chunks.length,
            } as Prisma.JsonObject,
          },
        }),
      ),
    );

    await sendAgentConfigWebhook(garageId);
    const knowledgeBase = await loadKnowledgeBase(garageId);
    return res.status(201).json({ knowledgeBase, uploadId, chunks: chunks.length });
  },
);

// Delete every chunk of one uploaded document (grouped by its uploadId) and re-sync.
router.delete(
  '/garages/:garageId/knowledge/:uploadId',
  authenticate,
  requireManagerLive,
  async (req: Request, res: Response) => {
    const { garageId, uploadId } = req.params;
    const allowedGarages = resolveAllowedGarages(req.user);
    if (!allowedGarages.includes(garageId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const result = await prisma.agentKnowledgeDocument.deleteMany({
      where: { garageId, metadata: { path: ['uploadId'], equals: uploadId } },
    });
    await sendAgentConfigWebhook(garageId);
    const knowledgeBase = await loadKnowledgeBase(garageId);
    return res.json({ knowledgeBase, deleted: result.count });
  },
);

// ── Tyresoft Services CSV upload ──────────────────────────────────────────────
// Takes the standard Tyresoft Services.csv export (one row per service / bracket)
// and writes it into integrationProviderConfig.tsServices + .pricingRules so the
// pricing editor and chat agent quote from it. Engine-size rows (those with both
// "Service Engine Size From" and "Service Engine Size To" filled) are grouped by
// their code stem (e.g. FS1/FS2/FS3 → "FS") into a single engine-size service
// whose brackets live in pricingRules. Rows with no engine size become fixed-
// price services.
const servicesCsvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB cap — these CSVs are small
});

type ParsedTsService = {
  id: string;
  name: string;
  pricingType: 'fixed' | 'engine-size';
  price?: number;
};
type ParsedBracket = { maxCC: number; price: number };

function parseServicesCsv(csv: string): {
  services: ParsedTsService[];
  pricingRules: Record<string, ParsedBracket[]>;
  warnings: string[];
} {
  const warnings: string[] = [];
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    throw new Error('CSV must contain a header row and at least one data row');
  }
  const headers = lines[0].split(',').map((h) => h.trim());
  const col = (name: string) => headers.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const iCode = col('Service Code');
  const iName = col('Service Name');
  const iPrice = col('Service Export Sell Price');
  const iFrom = col('Service Engine Size From');
  const iTo = col('Service Engine Size To');
  const missing: string[] = [];
  if (iCode < 0) missing.push('Service Code');
  if (iName < 0) missing.push('Service Name');
  if (iPrice < 0) missing.push('Service Export Sell Price');
  if (iFrom < 0) missing.push('Service Engine Size From');
  if (iTo < 0) missing.push('Service Engine Size To');
  if (missing.length) {
    throw new Error(`CSV is missing required columns: ${missing.join(', ')}`);
  }

  const fixed: ParsedTsService[] = [];
  const groups = new Map<string, { name: string; brackets: ParsedBracket[] }>();

  for (let lineNo = 1; lineNo < lines.length; lineNo++) {
    const cells = lines[lineNo].split(',').map((c) => c.trim());
    const code = cells[iCode];
    const name = cells[iName];
    const priceRaw = cells[iPrice];
    const fromRaw = cells[iFrom] ?? '';
    const toRaw = cells[iTo] ?? '';
    if (!code || !name) {
      warnings.push(`Row ${lineNo + 1}: missing code or name — skipped`);
      continue;
    }
    const price = parseFloat(priceRaw);
    if (!Number.isFinite(price)) {
      warnings.push(`Row ${lineNo + 1} (${code}): invalid price "${priceRaw}" — skipped`);
      continue;
    }
    const hasRange = fromRaw.length > 0 && toRaw.length > 0;
    if (hasRange) {
      const maxCC = parseInt(toRaw, 10);
      if (!Number.isFinite(maxCC)) {
        warnings.push(`Row ${lineNo + 1} (${code}): invalid engine-size To "${toRaw}" — skipped`);
        continue;
      }
      // Group by code with trailing digits stripped: FS1/FS2/FS3 → "FS".
      const stem = code.replace(/\d+$/, '') || code;
      // Strip the engine-size suffix from the row's name to get a clean family
      // name. e.g. "Full Service 0cc-1199cc" → "Full Service".
      const familyName = name.replace(/\s+\d+\s*cc\s*[-–]\s*\d+\s*cc\s*$/i, '').trim() || name;
      const g = groups.get(stem);
      if (g) {
        g.brackets.push({ maxCC, price });
      } else {
        groups.set(stem, { name: familyName, brackets: [{ maxCC, price }] });
      }
    } else {
      fixed.push({ id: code, name, pricingType: 'fixed', price });
    }
  }

  const services: ParsedTsService[] = [];
  const pricingRules: Record<string, ParsedBracket[]> = {};
  for (const [stem, g] of groups) {
    g.brackets.sort((a, b) => a.maxCC - b.maxCC);
    services.push({ id: stem, name: g.name, pricingType: 'engine-size' });
    pricingRules[stem] = g.brackets;
  }
  services.push(...fixed);
  return { services, pricingRules, warnings };
}

router.post(
  '/garages/:garageId/tyresoft-services-csv',
  authenticate,
  requireManagerLive,
  servicesCsvUpload.single('file'),
  async (req: Request, res: Response) => {
    const { garageId } = req.params;
    const allowedGarages = resolveAllowedGarages(req.user);
    if (!allowedGarages.includes(garageId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (!req.file?.buffer) {
      return res.status(400).json({ error: 'No CSV file uploaded' });
    }
    let parsed;
    try {
      parsed = parseServicesCsv(req.file.buffer.toString('utf8'));
    } catch (err) {
      return res
        .status(400)
        .json({ error: err instanceof Error ? err.message : 'CSV parse failed' });
    }
    const existing = await prisma.agentConfiguration.findUnique({
      where: { garageId },
      select: { integrationProviderConfig: true },
    });
    const baseConfig =
      existing?.integrationProviderConfig &&
      typeof existing.integrationProviderConfig === 'object' &&
      !Array.isArray(existing.integrationProviderConfig)
        ? (existing.integrationProviderConfig as Record<string, unknown>)
        : {};
    const totalBrackets = Object.values(parsed.pricingRules).reduce((a, b) => a + b.length, 0);
    const nextConfig = {
      ...baseConfig,
      tsServices: parsed.services,
      pricingRules: parsed.pricingRules,
      tsServicesUpload: {
        fileName: req.file.originalname,
        uploadedAt: new Date().toISOString(),
        services: parsed.services.length,
        brackets: totalBrackets,
      },
    };
    await prisma.agentConfiguration.update({
      where: { garageId },
      data: { integrationProviderConfig: nextConfig as Prisma.InputJsonValue },
    });
    await sendAgentConfigWebhook(garageId);
    return res.json({
      ok: true,
      imported: {
        services: parsed.services.length,
        brackets: totalBrackets,
      },
      warnings: parsed.warnings,
    });
  },
);

// Clear the uploaded Tyresoft services CSV. Removes tsServices, pricingRules,
// and tsServicesUpload from integrationProviderConfig (preserves everything else
// like credentials and hubspot). Used when the garage toggles "Give prices on
// calls" off.
router.delete(
  '/garages/:garageId/tyresoft-services-csv',
  authenticate,
  requireManagerLive,
  async (req: Request, res: Response) => {
    const { garageId } = req.params;
    const allowedGarages = resolveAllowedGarages(req.user);
    if (!allowedGarages.includes(garageId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const existing = await prisma.agentConfiguration.findUnique({
      where: { garageId },
      select: { integrationProviderConfig: true },
    });
    const baseConfig =
      existing?.integrationProviderConfig &&
      typeof existing.integrationProviderConfig === 'object' &&
      !Array.isArray(existing.integrationProviderConfig)
        ? (existing.integrationProviderConfig as Record<string, unknown>)
        : {};
    const { tsServices: _a, pricingRules: _b, tsServicesUpload: _c, ...rest } = baseConfig;
    await prisma.agentConfiguration.update({
      where: { garageId },
      data: { integrationProviderConfig: rest as Prisma.InputJsonValue },
    });
    await sendAgentConfigWebhook(garageId);
    return res.json({ ok: true });
  },
);

export default router;
