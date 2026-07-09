import { prisma } from '../db.js';
import { notifyMessaging } from './messagingNotifications.js';
import OpenAI from 'openai';
import axios from 'axios';
import { logChatToolCall } from './chatToolLog.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// Lazy-load OpenAI client
let openaiClient: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!openaiClient) {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured');
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openaiClient;
}

// Chat media (customer photos) lives in a PRIVATE S3 bucket, so gpt-4o can't fetch the raw URL.
// Presign a short-lived GET URL it can read. Mirrors the /media/signed-url route in messages.ts.
async function presignChatImage(url: string): Promise<string | null> {
  try {
    const accessKeyId = process.env.S3_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;
    if (!accessKeyId || !secretAccessKey) return null;
    const bucket = process.env.S3_MEDIA_BUCKET || process.env.S3_BUCKET || 'receptionmate-recordings';
    const region = process.env.AWS_REGION || 'eu-west-2';
    const key = new URL(url).pathname.replace(/^\//, '');
    const s3 = new S3Client({ region, credentials: { accessKeyId, secretAccessKey } });
    return await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 600 });
  } catch (e: any) {
    console.error('[TS_AGENT] presignChatImage failed:', e?.message);
    return null;
  }
}

interface ChatAgentResponse {
  content: string;
  needsHumanAssistance?: boolean;
}

interface PricingTier {
  maxCC: number;
  price: number;
}

interface ServiceDef {
  id: string | number;  // service code ('FS') OR Tyresoft numeric ID — DB stores string codes
  code?: string;        // explicit string code when id is numeric
  tsServiceId?: number; // Tyresoft numeric API service ID (for timeslots/booking); set when known
  name: string;
  pricingType: 'fixed' | 'engine-size';
  price?: number;       // only for pricingType === 'fixed'
}

// Returns the string service code for pricingRules lookup
function svcCode(s: ServiceDef): string {
  if (typeof s.id === 'string') return s.id;
  return s.code ?? '';
}

// Returns the numeric Tyresoft API service ID for slot/booking calls
// Falls back to 1 (general service bay) when not yet configured
function svcNumericId(s: ServiceDef): number {
  if (s.tsServiceId != null) return s.tsServiceId;
  if (typeof s.id === 'number') return s.id;
  return 1; // general service bay — use until real ID is provided by garage
}

interface TyresoftConfig {
  workspace: string;
  username: string;
  password: string;
  apiKey: string;
  depotId: number;
  channelId?: number;                          // Tyresoft channel ID (defaults to 24 if not set)
  pricingRules?: Record<string, PricingTier[]>; // keyed by service code e.g. 'OIL'
  tsServices?: ServiceDef[];                    // per-garage service list; overrides TYRESOFT_SERVICES
}

interface TyreProduct {
  stockNumber: string;
  ean: string;
  title: string;
  price: number;
  width: string;
  aspectRatio: string;
  rim: string;
  speedRating: string;
  loadIndex: string;
  brand: string;
  runflat: boolean;
  availability: string;
  leadTime: string;
  sourceSupplierID: number;
}

interface TyreBasketItem {
  stockNumber: string;
  quantity: number;
  unitPrice: number;
  description: string;
  leadTimeDays: number;
  sourceSupplierID: number;
}

interface TyresoftSession {
  vrm?: string;
  vehicle?: any;
  serviceIds?: number[];
  serviceName?: string;
  tyreBasket?: TyreBasketItem[];
  customerName?: string;
  customerPhone?: string;
  availableSlots?: { date: string; time: string; diaryCategoryID: number; estimatedTime: number; slotTypeID: number }[];
  selectedSlot?: { date: string; time: string; diaryCategoryId: number; estimatedTime: number; slotTypeId: number };
  lastTyreSearch?: { stock_number: string; description: string; price: number; availability: string; lead_time: string; source_supplier_id: number }[];
  branchOverride?: number;  // depot ID set by ts_set_branch (1 = Branch 1, 3 = Branch 2)
}

// ---------------------------------------------------------------------------
// Tyre inventory — loaded from CSV at startup
// ---------------------------------------------------------------------------

const TYRE_INVENTORY = new Map<number, TyreProduct[]>();

export function invalidateTyreCache(_garageId?: string, _depotId?: string | number): void { TYRE_INVENTORY.clear(); }

function parseCSV(filePath: string): TyreProduct[] {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    console.warn(`[TS_AGENT] Tyre CSV not found: ${filePath}`);
    return [];
  }

  const lines = content.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];

  const headers = lines[0].split(',');
  const idx = (name: string) => headers.findIndex(h => h.trim() === name);

  const iStockNum   = idx('Product Stock Number');
  const iEAN        = idx('Product EAN');
  const iTitle      = idx('Product Title');
  const iRetail     = idx('Retail');
  const iWidth      = idx('Width');
  const iAspect     = idx('Aspect Ratio');
  const iRim        = idx('Rim');
  const iSpeed      = idx('Speed Rating');
  const iLoad       = idx('Load Index');
  const iBrand      = idx('Brand Name');
  const iRunflat    = idx('Runflat');
  const iAvail      = idx('Product Channel Available');
  const iLeadTime   = idx('Product Channel Lead Time');
  const iSourceSupp = idx('Product Channel Source Supplier ID');

  const products: TyreProduct[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < 5) continue;
    const price = parseFloat(cols[iRetail] ?? '0') || 0;
    products.push({
      stockNumber:  cols[iStockNum]?.trim()  ?? '',
      ean:          cols[iEAN]?.trim()       ?? '',
      title:        cols[iTitle]?.trim()     ?? '',
      price,
      width:        cols[iWidth]?.trim()     ?? '',
      aspectRatio:  cols[iAspect]?.trim()    ?? '',
      rim:          cols[iRim]?.trim()       ?? '',
      speedRating:  cols[iSpeed]?.trim()     ?? '',
      loadIndex:    cols[iLoad]?.trim()      ?? '',
      brand:        cols[iBrand]?.trim()     ?? '',
      runflat:      (cols[iRunflat]?.trim().toUpperCase() ?? '') === 'TRUE',
      availability:     cols[iAvail]?.trim()     ?? '',
      leadTime:         cols[iLeadTime]?.trim()  ?? '',
      sourceSupplierID: parseInt(cols[iSourceSupp]?.trim() || '0') || 0,
    });
  }
  return products;
}

function loadTyreInventory(): void {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname  = dirname(__filename);
  const dataDir    = join(__dirname, '../../data');

  const branch1 = parseCSV(join(dataDir, 'tyresoft-products-depot-1.csv'));
  const branch2 = parseCSV(join(dataDir, 'tyresoft-products-depot-2.csv'));

  TYRE_INVENTORY.set(1, branch1);  // depot 1 → Branch 1
  TYRE_INVENTORY.set(3, branch2);  // depot 3 → Branch 2

  console.log(`[TS_AGENT] Tyre inventory loaded: depot1=${branch1.length}, depot3=${branch2.length}`);
}

loadTyreInventory();

// Parse "2 Days" → 2, "In Stock" / "0" / "" → 0
function parseLeadTimeDays(leadTime: string): number {
  if (!leadTime) return 0;
  const m = leadTime.match(/(\d+)/);
  return m ? parseInt(m[1]) : 0;
}

// Return YYYY-MM-DD that is `days` calendar days from today
function addDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Tyre search helper
// ---------------------------------------------------------------------------

function parseTyreSize(size: string): { width: string; aspect: string; rim: string } {
  // Strip trailing load index + speed rating (e.g. "235/60R18 107V" → "235/60R18")
  const stripped = size.trim().replace(/\s+\d{2,3}[A-Z]{1,2}(\s+.*)?$/, '').trim();
  const clean = stripped.toUpperCase().replace(/\s+/g, '');
  let width = '', aspect = '', rim = '';

  if (clean.includes('/')) {
    const slashIdx = clean.indexOf('/');
    width = clean.slice(0, slashIdx);
    const rest = clean.slice(slashIdx + 1);
    const rIdx = rest.indexOf('R');
    if (rIdx !== -1) {
      aspect = rest.slice(0, rIdx);
      rim    = rest.slice(rIdx + 1).replace(/[^0-9]/g, '');
    }
  } else if (clean.length >= 7) {
    width  = clean.slice(0, 3);
    aspect = clean.slice(3, 5);
    rim    = clean.slice(5, 7);
  }

  return { width, aspect, rim };
}

function searchTyres(depotId: number, size: string, brand?: string, maxResults = 5): TyreProduct[] {
  const inventory = TYRE_INVENTORY.get(depotId) ?? TYRE_INVENTORY.get(1) ?? [];
  const { width, aspect, rim } = parseTyreSize(size);

  const matches = inventory.filter(t => {
    if (width  && t.width       !== width)  return false;
    if (aspect && t.aspectRatio !== aspect) return false;
    if (rim    && t.rim         !== rim)    return false;
    if (brand  && !t.brand.toUpperCase().includes(brand.toUpperCase())) return false;
    return true;
  });

  matches.sort((a, b) => a.price - b.price);
  return matches.slice(0, maxResults);
}

// ---------------------------------------------------------------------------
// In-memory session state (per conversation)
// ---------------------------------------------------------------------------

const tsSessions = new Map<string, TyresoftSession>();

// ---------------------------------------------------------------------------
// Static service catalogue (matches Tyresoft voice agent configuration)
// ---------------------------------------------------------------------------

const TYRESOFT_SERVICES = [
  { id: 3,  code: 'WA',   name: 'Wheel Alignment',               price: 47.99  },
  { id: 11, code: 'AIR1', name: 'Air Con Recharge',              price: 84.00  },
  { id: 2,  code: 'FS1',  name: 'Full Service (up to 1600cc)',   price: 132.00 },
  { id: 57, code: 'FS2',  name: 'Full Service (1601-2000cc)',    price: 154.00 },
  { id: 8,  code: 'FS3',  name: 'Full Service (over 2000cc)',    price: 175.00 },
  { id: 20, code: 'FSE1', name: 'Hybrid Service',                price: 155.94 },
  { id: 58, code: 'MOT4', name: 'MOT (Class 4)',                 price: 50.00  },
  { id: 22, code: 'PUNC', name: 'Puncture Repair',               price: 12.00  },
];

// Deterministic engine-size pricing — no LLM arithmetic
function getServicePriceForEngine(
  serviceCode: string,
  engineCC: number,
  pricingRules: Record<string, PricingTier[]>
): number | null {
  const tiers = pricingRules[serviceCode];
  if (!tiers) return null;
  const tier = tiers.find(t => engineCC <= t.maxCC);
  return tier?.price ?? null;
}

function tsHeaders(cfg: TyresoftConfig): Record<string, string> {
  const creds = Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');
  return {
    Authorization: `Basic ${creds}`,
    'x-api-key': cfg.apiKey,
    'Content-Type': 'application/json',
  };
}

function tsBaseUrl(cfg: TyresoftConfig): string {
  return `https://3p-api.tyresoft.biz/v1/${cfg.workspace}`;
}

function toTitleCase(str: string): string {
  return str.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function getTomorrow(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

export async function getTyresoftChatResponse(
  garageId: string,
  message: string,
  conversationId: string,
  seedContact?: { phone?: string; name?: string }
): Promise<ChatAgentResponse> {
  try {
    const garage = await prisma.garage.findUnique({
      where: { id: garageId },
      include: {
        agentConfiguration: true,
        knowledgeDocuments: {
          orderBy: { updatedAt: 'desc' },
          take: 10,
        },
      },
    });

    if (!garage?.agentConfiguration) throw new Error('Garage configuration not found');

    const config = garage.agentConfiguration;

    // Load Tyresoft credentials from integrationProviderConfig
    // Supports two storage formats:
    //   flat:   { workspace, username, ... }          (legacy test/Lurgan Tyre format)
    //   nested: { tyresoft: { tsWorkspace, ... } }    (Elite Autocare and newer garages)
    let tsConfig: TyresoftConfig | undefined;
    if (config.integrationProviderConfig && typeof config.integrationProviderConfig === 'object') {
      const raw = config.integrationProviderConfig as any;
      const src = raw.tyresoft || raw; // resolve nested format if present
      const workspace    = src.tsWorkspace  || src.workspace  || '';
      const username     = src.tsUsername   || src.username   || '';
      const password     = src.tsPassword   || src.password   || '';
      const apiKey       = src.tsApiKey     || src.apiKey     || '';
      const depotId      = Number(src.tsDepotId  || src.depotId  || 1);
      const channelId    = (src.tsChannelId || src.channelId) ? Number(src.tsChannelId || src.channelId) : undefined;
      const pricingRules: Record<string, PricingTier[]> | undefined = src.pricingRules ?? undefined;
      const tsServices: ServiceDef[] | undefined = src.tsServices ?? undefined;
      if (workspace && username && password && apiKey) {
        tsConfig = { workspace, username, password, apiKey, depotId, channelId, pricingRules, tsServices };
      }
    }

    console.log('[TS_AGENT] Config loaded:', { garageId, hasApiCreds: !!tsConfig });

    const isOpen    = checkOpeningHours(config.weeklyOpeningHours);
    const session   = tsSessions.get(conversationId) || {};
    const messagingHandoff = (config as any).messagingHumanHandoff !== false; // chat handoff; default ON
    let tools       = buildTools(tsConfig);
    if (!messagingHandoff) tools = tools.filter((t) => !['ts_take_message', 'ts_request_callback'].includes((t as any).function?.name));
    const sysPrompt = buildSystemPrompt(config, garage.knowledgeDocuments, isOpen, session, !!tsConfig, messagingHandoff, tsConfig);

    // Build message history
    const previousMessages = (await prisma.chatMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })).reverse();

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: sysPrompt },
    ];

    const total = previousMessages.length;
    for (let i = 0; i < total; i++) {
      const msg = previousMessages[i];
      const role = msg.role === 'user' ? 'user' : 'assistant';
      // Pass recent customer image attachments to the (vision-capable gpt-4o) model so it can
      // actually read plates / logbooks / warning lights. Only the last few to avoid re-sending
      // old images every turn. Private S3 → presign a short-lived URL the model can fetch.
      if (role === 'user' && i >= total - 4 && msg.mediaType?.startsWith('image/') && msg.mediaUrl) {
        const signed = await presignChatImage(msg.mediaUrl);
        if (signed) {
          const caption = msg.content && !['[Image]', '[Customer sent an image]'].includes(msg.content)
            ? msg.content
            : 'The customer sent this image. Use it to help — e.g. read a registration plate, logbook/V5C, or dashboard warning light.';
          messages.push({ role: 'user', content: [
            { type: 'text', text: caption },
            { type: 'image_url', image_url: { url: signed } },
          ] } as OpenAI.Chat.ChatCompletionMessageParam);
          continue;
        }
      }
      messages.push({ role, content: msg.content });
    }

    // Inject seed contact context on first message
    let userContent = message;
    if (seedContact && previousMessages.length === 0) {
      const hints: string[] = [];
      if (seedContact.name)  hints.push(`[Customer name: ${seedContact.name}]`);
      if (seedContact.phone) hints.push(`[Customer phone: ${seedContact.phone}]`);
      if (hints.length) userContent = `${hints.join(' ')} ${message}`;
    }
    // Don't re-append the current turn as a bare image placeholder — the loop above already
    // attached the actual image when it's in the persisted history (WhatsApp persists before us).
    const lastPrev = previousMessages[previousMessages.length - 1];
    const currentIsImagePlaceholder = ['[Customer sent an image]', '[Image]'].includes(message);
    const lastPrevIsImage = lastPrev?.role === 'user' && !!lastPrev?.mediaType?.startsWith('image/');
    if (!(currentIsImagePlaceholder && lastPrevIsImage)) {
      messages.push({ role: 'user', content: userContent });
    }

    const hasTyreBasket = (session.tyreBasket?.length ?? 0) > 0;
    const temperature   = (session.serviceIds?.length || hasTyreBasket) ? 0.5 : 0.9;

    let response = await getOpenAI().chat.completions.create({
      model: 'gpt-4o',
      messages,
      temperature,
      max_tokens: 250,
      tools,
      tool_choice: 'auto',
    });

    // Tool-call loop
    let iterations = 0;
    while (response.choices[0]?.finish_reason === 'tool_calls' && iterations < 5) {
      iterations++;
      const toolCalls = response.choices[0].message.tool_calls!;
      messages.push(response.choices[0].message);

      for (const call of toolCalls) {
        if (call.type !== 'function') continue;
        let args: any;
        try {
          args = JSON.parse(call.function.arguments);
        } catch {
          console.error(`[TS_AGENT] Failed to parse tool args for ${call.function.name}:`, call.function.arguments);
          args = {};
        }
        console.log(`[TS_AGENT] Tool call: ${call.function.name}`, args);

        const _t0 = Date.now();
        const result = await executeTool(call.function.name, args, conversationId, tsConfig);
        logChatToolCall({ conversationId, garageId, agentType: 'tyresoft', toolName: call.function.name, args, result, durationMs: Date.now() - _t0 });
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }

      response = await getOpenAI().chat.completions.create({
        model: 'gpt-4o',
        messages,
        temperature,
        max_tokens: 250,
        tools,
        tool_choice: 'auto',
      });
    }

    const content = response.choices[0]?.message?.content ||
      'Sorry, I\'m unable to respond right now. Please try again or call us directly.';

    return { content, needsHumanAssistance: false };
  } catch (error) {
    console.error('[TS_AGENT] Error:', error);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

function buildTools(tsConfig?: TyresoftConfig): OpenAI.Chat.ChatCompletionTool[] {
  const hasCreds = !!tsConfig;
  const tools: OpenAI.Chat.ChatCompletionTool[] = [
    {
      type: 'function',
      function: {
        name: 'ts_get_services',
        description: 'Return the list of bookable services with prices. Call when the customer asks what services are available or wants to book a service (not tyres).',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'ts_get_service_price',
        description: 'Get the exact price for an engine-size-priced service. You MUST have already called ts_get_services (for the exact service code) and ts_lookup_vehicle (for engineCapacity). Pass serviceCode EXACTLY as returned by ts_get_services — do not abbreviate or guess it. Never calculate prices yourself.',
        parameters: {
          type: 'object',
          properties: {
            serviceCode: { type: 'string', description: 'The EXACT service code from ts_get_services (e.g. FULL_SERVICE) — copy it verbatim, never abbreviate (not "FS").' },
            engineCC:    { type: 'number', description: 'Engine capacity in CC from the VRM lookup result' },
          },
          required: ['serviceCode', 'engineCC'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'ts_take_message',
        description: 'Take a message from the customer when they want to speak to a human, leave a message, or make a request the AI cannot handle. Call this tool after collecting their message and phone number.',
        parameters: {
          type: 'object',
          properties: {
            message:  { type: 'string', description: 'The customer message to pass on to the team' },
            phone:    { type: 'string', description: 'Customer phone number' },
          },
          required: ['message', 'phone'],
        },
      },
    },
  ];

  if (!hasCreds) return tools;

  tools.push(
    {
      type: 'function',
      function: {
        name: 'ts_lookup_vehicle',
        description: 'Look up a vehicle by registration plate. MUST be called for ALL bookings — tyres AND services (MOT, Full Service, alignment, etc.) — to confirm make/model and link the vehicle to the booking. Call as soon as you have the reg.',
        parameters: {
          type: 'object',
          properties: {
            vrm: { type: 'string', description: 'Vehicle registration number, e.g. AB12 CDE' },
          },
          required: ['vrm'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'ts_search_tyres',
        description: 'Search the tyre inventory by size and optionally brand. Returns up to 5 cheapest options with stock numbers and prices. Call after you have a tyre size (from VRM lookup or customer).',
        parameters: {
          type: 'object',
          properties: {
            size: {
              type: 'string',
              description: 'Tyre size, e.g. "205/55R16". Use the default front tyre size from the VRM lookup if available.',
            },
            brand: {
              type: 'string',
              description: 'Optional brand filter, e.g. "Michelin". Omit to show all brands.',
            },
          },
          required: ['size'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'ts_add_tyre_to_basket',
        description: 'Add a selected tyre to the customer basket. ONLY call after presenting the tyre options list to the customer AND the customer has explicitly chosen a specific tyre. Never auto-select — always wait for customer choice.',
        parameters: {
          type: 'object',
          properties: {
            stock_number:  { type: 'string', description: 'Stock number of the chosen tyre' },
            quantity:      { type: 'number', description: 'Number of tyres (default 4 for full set, 2 for axle, 1 for single)' },
            unit_price:    { type: 'number', description: 'Price per tyre from the search results' },
            description:   { type: 'string', description: 'Short description, e.g. "Michelin Primacy 4 205/55R16"' },
          },
          required: ['stock_number', 'quantity', 'unit_price', 'description'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'ts_view_tyre_basket',
        description: 'Show the current tyre basket with items and total cost.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'ts_clear_tyre_basket',
        description: 'Clear all items from the tyre basket so the customer can start over.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'ts_confirm_slot',
        description: 'Save the customer\'s chosen time slot to the session. Call this as soon as the customer selects a slot so it is remembered for the booking.',
        parameters: {
          type: 'object',
          properties: {
            slot_date: { type: 'string', description: 'Date of the slot e.g. 2026-03-26' },
            slot_time: { type: 'string', description: 'Time of the slot e.g. 13:30' },
          },
          required: ['slot_date', 'slot_time'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'ts_save_customer_details',
        description: 'Save the customer name and phone number to the session. Call as soon as you have both the name AND phone number from the customer — do not wait until booking.',
        parameters: {
          type: 'object',
          properties: {
            customer_name:  { type: 'string', description: 'Full name of the customer' },
            customer_phone: { type: 'string', description: 'UK phone number of the customer' },
          },
          required: ['customer_name', 'customer_phone'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'ts_get_timeslots',
        description: 'Fetch available booking timeslots. For tyres use service_ids=[0]. For services use the service ID. Call after the customer has confirmed their choice.',
        parameters: {
          type: 'object',
          properties: {
            service_ids: {
              type: 'array',
              items: { type: 'number' },
              description: 'Service IDs: [0] for tyre fitting, [3] for wheel alignment, [58] for MOT, etc.',
            },
            start_date: {
              type: 'string',
              description: 'Earliest date to search from, YYYY-MM-DD. Defaults to tomorrow.',
            },
          },
          required: ['service_ids'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'ts_check_preferred_time',
        description: 'Find the closest available slot to the customer\'s stated time preference. Use when the customer says "around 10", "morning", "afternoon", "2pm", "after 3", etc. Must call ts_get_timeslots first.',
        parameters: {
          type: 'object',
          properties: {
            preferred_time: {
              type: 'string',
              description: 'The customer\'s time preference as they said it, e.g. "around 10", "morning", "2pm", "after 3"',
            },
          },
          required: ['preferred_time'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'ts_list_all_slots',
        description: 'Return the full list of all available slots already fetched. Call when the customer asks to see all times or says none of the suggested slots work for them.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'ts_set_branch',
        description: 'Switch the active branch. Call when the customer asks to book at a different branch or location.',
        parameters: {
          type: 'object',
          properties: {
            branch: {
              type: 'number',
              description: 'Branch number: 1 for Branch 1 (main branch), 2 for Branch 2',
            },
          },
          required: ['branch'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'ts_request_callback',
        description: 'Log a callback request when the customer explicitly asks to be called back rather than booking online. Distinct from ts_take_message — use this specifically when the customer says "can someone call me?" or prefers a phone callback.',
        parameters: {
          type: 'object',
          properties: {
            name:  { type: 'string', description: 'Customer name' },
            phone: { type: 'string', description: 'Phone number to call back on' },
            notes: { type: 'string', description: 'Brief reason for callback or what they want to discuss (optional)' },
          },
          required: ['name', 'phone'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'ts_create_booking',
        description: 'Create the booking after the customer has explicitly confirmed all details.',
        parameters: {
          type: 'object',
          properties: {
            customer_name:     { type: 'string', description: 'Customer full name' },
            customer_phone:    { type: 'string', description: 'UK mobile or phone number' },
            customer_email:    { type: 'string', description: 'Email address (optional)' },
            customer_postcode: { type: 'string', description: 'UK postcode (optional)' },
            slot_date:         { type: 'string', description: 'Booking date YYYY-MM-DD' },
            slot_time:         { type: 'string', description: 'Booking time HH:MM' },
            diary_category_id: { type: 'number', description: 'diaryCategoryID from the chosen slot' },
            estimated_time:    { type: 'number', description: 'estimatedTime from the chosen slot' },
            slot_type_id:      { type: 'number', description: 'slotTypeID from the chosen slot' },
            service_ids: {
              type: 'array',
              items: { type: 'number' },
              description: 'Service IDs: [0] for tyre fitting, or the appropriate service IDs for other services.',
            },
          },
          required: [
            'customer_name', 'customer_phone',
            'slot_date', 'slot_time', 'diary_category_id', 'estimated_time', 'slot_type_id',
            'service_ids',
          ],
        },
      },
    }
  );

  return tools;
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

async function executeTool(
  name: string,
  args: any,
  conversationId: string,
  tsConfig?: TyresoftConfig
): Promise<any> {
  const session = tsSessions.get(conversationId) || {};

  try {
    switch (name) {
      case 'ts_get_services': {
        const serviceList = tsConfig?.tsServices
          ? tsConfig.tsServices.map(s => ({
              id:    svcNumericId(s),  // numeric ID for ts_get_timeslots; 1 = general bay if not yet configured
              code:  svcCode(s),
              name:  s.name,
              price: s.pricingType === 'fixed'
                ? `£${s.price!.toFixed(2)}`
                : 'Varies by engine size — call ts_get_service_price after VRM lookup to get the exact price',
            }))
          : TYRESOFT_SERVICES.map(s => ({ id: s.id, code: s.code, name: s.name, price: `£${s.price.toFixed(2)}` }));
        return { services: serviceList };
      }

      case 'ts_get_service_price': {
        if (!tsConfig?.pricingRules) {
          return { error: 'No engine-size pricing rules configured for this garage' };
        }
        // Accept both service code and service name — normalise to uppercase for lookup
        const rawCode     = String(args.serviceCode || '');
        const serviceCode = rawCode.toUpperCase();
        const engineCC    = Number(args.engineCC) || 0;
        // Try exact match first, then case-insensitive match on pricingRules keys
        let price = getServicePriceForEngine(serviceCode, engineCC, tsConfig.pricingRules);
        if (price === null) {
          // Try lowercase (e.g. 'adas')
          price = getServicePriceForEngine(rawCode.toLowerCase(), engineCC, tsConfig.pricingRules);
        }
        if (price === null) {
          const knownCodes = Object.keys(tsConfig.pricingRules).join(', ');
          return { error: `No pricing tier found for "${args.serviceCode}". Engine-size pricing is configured for: ${knownCodes}` };
        }
        console.log(`[TS_AGENT] Engine-size price: ${rawCode} @ ${engineCC}cc → £${price.toFixed(2)}`);
        return { serviceCode: rawCode, engineCC, price: `£${price.toFixed(2)}`, priceNumeric: price };
      }

      case 'ts_lookup_vehicle': {
        if (!tsConfig) return { error: 'Tyresoft API not configured for this garage' };
        const vrm = String(args.vrm).toUpperCase().replace(/\s+/g, '');
        const resp = await axios.get(
          `${tsBaseUrl(tsConfig)}/vrmLookup/${vrm}`,
          { headers: tsHeaders(tsConfig), timeout: 15000 }
        );
        const vehicle = resp.data;
        // Title-case make/model so the LLM never sees ALL CAPS from the API
        if (vehicle.make)  vehicle.make  = toTitleCase(vehicle.make);
        if (vehicle.model) vehicle.model = toTitleCase(vehicle.model);
        tsSessions.set(conversationId, { ...session, vrm, vehicle });
        console.log(`[TS_AGENT] VRM lookup OK: ${vrm} -> ${vehicle.make} ${vehicle.model} (${vehicle.yearOfManufacture || vehicle.year})`);
        return vehicle;
      }

      case 'ts_search_tyres': {
        if (!tsConfig) return { error: 'Tyresoft API not configured for this garage' };
        const size     = String(args.size || '');
        const brand    = args.brand ? String(args.brand) : undefined;
        const depotId  = session.branchOverride ?? tsConfig.depotId;
        const results  = searchTyres(depotId, size, brand);
        if (results.length === 0) {
          return {
            found: 0,
            message: `No tyres found for size ${size}${brand ? ` (brand: ${brand})` : ''}. Try a different size or omit the brand filter.`,
          };
        }
        const tyreList = results.map((t, i) => ({
          stock_number:       t.stockNumber,
          description:        t.title,
          brand:              t.brand,
          price:              t.price,
          availability:       t.availability || 'In Stock',
          lead_time:          t.leadTime,
          source_supplier_id: t.sourceSupplierID,
          runflat:            t.runflat,
          _index:             i + 1,
        }));
        // Store real stock codes + availability in session so they can't be hallucinated
        tsSessions.set(conversationId, {
          ...session,
          lastTyreSearch: tyreList.map(t => ({
            stock_number:       t.stock_number,
            description:        t.description,
            price:              t.price,
            availability:       t.availability,
            lead_time:          t.lead_time,
            source_supplier_id: t.source_supplier_id,
          })),
        });
        console.log(`[TS_AGENT] Tyre search: size=${size}, brand=${brand}, depot=${depotId}, found=${results.length}`);
        return { found: results.length, size, tyres: tyreList };
      }

      case 'ts_add_tyre_to_basket': {
        // Resolve real stock number from session — LLM often hallucinates short codes
        const llmStockNumber = String(args.stock_number || '');
        const llmDescription = String(args.description || '').toLowerCase();
        const search = session.lastTyreSearch || [];
        const matched = search.find(t =>
          t.stock_number === llmStockNumber ||
          t.description.toLowerCase().includes(llmDescription) ||
          llmDescription.includes(t.description.toLowerCase().split(' ').slice(0, 3).join(' '))
        ) || search.find(t => t.stock_number.includes(llmStockNumber)) || null;
        const resolvedStockNumber = matched ? matched.stock_number : llmStockNumber;
        const resolvedPrice       = matched ? matched.price        : (Number(args.unit_price) || 0);
        const resolvedDescription = matched ? matched.description  : String(args.description || '');
        if (matched && matched.stock_number !== llmStockNumber) {
          console.log(`[TS_AGENT] Stock number resolved: LLM sent "${llmStockNumber}" → real code "${resolvedStockNumber}"`);
        }
        const item: TyreBasketItem = {
          stockNumber:      resolvedStockNumber,
          quantity:         Number(args.quantity) || 4,
          unitPrice:        resolvedPrice,
          description:      resolvedDescription,
          leadTimeDays:     matched ? parseLeadTimeDays(matched.lead_time) : 0,
          sourceSupplierID: matched ? (matched.source_supplier_id ?? 0) : 0,
        };
        const basket = [...(session.tyreBasket || []), item];
        tsSessions.set(conversationId, { ...session, tyreBasket: basket });
        const total = item.quantity * item.unitPrice;
        console.log(`[TS_AGENT] Tyre added to basket: ${item.description} x${item.quantity} @ £${item.unitPrice} = £${total}`);
        return {
          success: true,
          item,
          basket_total: basket.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0),
          basket_count: basket.length,
        };
      }

      case 'ts_view_tyre_basket': {
        const basket = session.tyreBasket || [];
        if (basket.length === 0) return { empty: true, message: 'No tyres in basket yet.' };
        const total = basket.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0);
        return {
          items: basket.map(i => ({
            description: i.description,
            stock_number: i.stockNumber,
            quantity: i.quantity,
            unit_price: i.unitPrice,
            line_total: i.quantity * i.unitPrice,
          })),
          total,
        };
      }

      case 'ts_clear_tyre_basket': {
        tsSessions.set(conversationId, { ...session, tyreBasket: [] });
        return { success: true, message: 'Basket cleared.' };
      }

      case 'ts_save_customer_details': {
        const customerName  = String(args.customer_name || '').trim();
        const customerPhone = String(args.customer_phone || '').trim();
        tsSessions.set(conversationId, { ...session, customerName, customerPhone });
        console.log(`[TS_AGENT] Customer details saved: name=${customerName}, phone=${customerPhone}`);
        // Persist name + phone to the conversation so it shows in the portal
        if (conversationId && (customerName || customerPhone)) {
          await prisma.chatConversation.updateMany({
            where: { id: conversationId },
            data: {
              ...(customerName ? { customerName } : {}),
              ...(customerPhone ? { customerPhone } : {}),
            },
          });
        }
        return { success: true, customer_name: customerName, customer_phone: customerPhone };
      }

      case 'ts_confirm_slot': {
        const slotDate = String(args.slot_date || '').trim();
        const slotTime = String(args.slot_time || '').trim();
        const matched  = (session.availableSlots || []).find(s => s.date === slotDate && s.time === slotTime);
        if (!matched) {
          return { error: 'Slot not found in available slots. Call ts_get_timeslots again to refresh.' };
        }
        const selectedSlot = { date: matched.date, time: matched.time, diaryCategoryId: matched.diaryCategoryID, estimatedTime: matched.estimatedTime, slotTypeId: matched.slotTypeID };
        tsSessions.set(conversationId, { ...session, selectedSlot });
        console.log(`[TS_AGENT] Slot confirmed: ${slotDate} ${slotTime}`);
        return { success: true, slot_date: slotDate, slot_time: slotTime };
      }

      case 'ts_get_timeslots': {
        if (!tsConfig) return { error: 'Tyresoft API not configured for this garage' };

        // Server-side guardrail: ALL service bookings require a prior VRM lookup
        const requestedIds: number[] = args.service_ids || [];
        const hasTyreOnly = requestedIds.length === 1 && requestedIds[0] === 0;
        if (!hasTyreOnly && requestedIds.length > 0 && !session.vrm) {
          return {
            error: 'vehicle_registration_required',
            directive:
              'A vehicle registration is required before booking any service. Ask the customer for their registration plate and call ts_lookup_vehicle first.',
          };
        }

        // Apply lead time: if any basket item is partner stock, push start date out accordingly
        const maxLeadDays = (session.tyreBasket || []).reduce((max, t) => Math.max(max, t.leadTimeDays || 0), 0);
        const startDate   = args.start_date || (maxLeadDays > 0 ? addDays(maxLeadDays) : getTomorrow());
        const slotDepotId  = session.branchOverride ?? tsConfig.depotId;
        const resp = await axios.post(
          `${tsBaseUrl(tsConfig)}/availableSlotsForBasket/${slotDepotId}/${startDate}`,
          { list: args.service_ids },
          { headers: tsHeaders(tsConfig), timeout: 15000 }
        );
        // Store full slot metadata in session — LLM only gets date+time
        const rawSlots: any[] = Array.isArray(resp.data) ? resp.data : [];
        const availableSlots = rawSlots.map((s: any) => {
          const req = s.requiredSlots?.[0] || {};
          return {
            date:            s.date,
            time:            s.time,
            diaryCategoryID: req.diaryCategoryID ?? s.diaryCategoryID ?? 1,
            estimatedTime:   req.estimatedTime   ?? s.estimatedTime   ?? 30,
            slotTypeID:      req.slotTypeID       ?? s.slotTypeID      ?? 1,
          };
        });
        tsSessions.set(conversationId, { ...session, serviceIds: args.service_ids, availableSlots });
        console.log(`[TS_AGENT] Timeslots fetched for service_ids=${JSON.stringify(args.service_ids)}, date=${startDate}, count=${availableSlots.length}`);
        // Return only date+time — no metadata the LLM can misuse
        return { available_slots: availableSlots.slice(0, 10).map(s => ({ date: s.date, time: s.time })) };
      }

      case 'ts_check_preferred_time': {
        const slots = session.availableSlots || [];
        if (slots.length === 0) {
          return { error: 'No slots loaded yet. Call ts_get_timeslots first, then call this tool.' };
        }
        const pref = String(args.preferred_time || '').toLowerCase().trim();

        // Parse preferred hour from natural language
        let prefHour = -1;
        let prefMinute = 0;
        const pmMatch = pref.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/);
        if (pmMatch) {
          prefHour   = parseInt(pmMatch[1]);
          prefMinute = parseInt(pmMatch[2] || '0');
          if (pmMatch[3] === 'pm' && prefHour < 12) prefHour += 12;
          if (pmMatch[3] === 'am' && prefHour === 12) prefHour = 0;
        } else {
          const timeMatch = pref.match(/(\d{1,2}):(\d{2})/);
          if (timeMatch) {
            prefHour   = parseInt(timeMatch[1]);
            prefMinute = parseInt(timeMatch[2]);
          } else {
            const numMatch = pref.match(/\b(\d{1,2})\b/);
            if (numMatch) {
              prefHour = parseInt(numMatch[1]);
              if (prefHour <= 6) prefHour += 12; // assume "2" = 14:00
            } else if (pref.includes('morning') || pref.includes('early')) {
              prefHour = 9;
            } else if (pref.includes('afternoon') || pref.includes('lunch')) {
              prefHour = 13;
            } else if (pref.includes('evening') || pref.includes('late')) {
              prefHour = 16;
            }
          }
        }

        if (prefHour < 0) {
          return {
            message: 'Could not parse that time preference — here are the next available slots.',
            slots: slots.slice(0, 5).map(s => ({ date: s.date, time: s.time })),
          };
        }

        const prefMins = prefHour * 60 + prefMinute;
        const scored = slots.map(s => {
          const [h, m] = s.time.split(':').map(Number);
          return { ...s, distance: Math.abs(h * 60 + m - prefMins) };
        }).sort((a, b) => a.distance - b.distance);

        const best         = scored[0];
        const alternatives = scored.slice(1, 4);
        console.log(`[TS_AGENT] Preferred time "${args.preferred_time}" → best match ${best.date} ${best.time}`);
        return {
          best_match:   { date: best.date, time: best.time },
          alternatives: alternatives.map(s => ({ date: s.date, time: s.time })),
          message: `Closest slot to "${args.preferred_time}" is ${best.time} on ${best.date}.`,
        };
      }

      case 'ts_list_all_slots': {
        const slots = session.availableSlots || [];
        if (slots.length === 0) {
          return { error: 'No slots loaded yet. Call ts_get_timeslots first.' };
        }
        return { all_slots: slots.map(s => ({ date: s.date, time: s.time })), total: slots.length };
      }

      case 'ts_set_branch': {
        const branch  = Number(args.branch) || 1;
        const depotId = branch === 2 ? 3 : 1; // branch 1 → depot 1, branch 2 → depot 3
        // Clear tyre search + slots since they belong to the old branch
        tsSessions.set(conversationId, {
          ...session,
          branchOverride:  depotId,
          availableSlots:  undefined,
          lastTyreSearch:  undefined,
          tyreBasket:      [],
        });
        console.log(`[TS_AGENT] Branch switched to ${branch} (depotId=${depotId})`);
        return {
          success:  true,
          branch,
          depot_id: depotId,
          message:  `Switched to Branch ${branch}. Previous tyre searches and slots cleared — please search again.`,
        };
      }

      case 'ts_request_callback': {
        const name  = String(args.name  || '').trim();
        const phone = String(args.phone || '').trim();
        const notes = String(args.notes || '').trim();
        console.log(`[CALLBACK REQUEST] ${JSON.stringify({
          timestamp: new Date().toUTCString(),
          channel:   'chat',
          name,
          phone,
          notes,
        })}`);
        if (conversationId) {
          await prisma.chatConversation.updateMany({
            where: { id: conversationId },
            data: {
              needsAttention: true,
              agentPaused:    true,
              ...(name  ? { customerName:  name  } : {}),
              ...(phone ? { customerPhone: phone } : {}),
            },
          });
          console.log(`[TS_AGENT] Callback request logged for ${name} (${phone})`);
          void notifyMessaging({ conversationId, event: 'escalated' });
        }
        return { success: true, message: 'Callback request logged.' };
      }

      case 'ts_create_booking': {
        if (!tsConfig) return { error: 'Tyresoft API not configured for this garage' };
        return await tsCreateBooking(args, session, tsConfig, conversationId);
      }

      case 'ts_take_message': {
        const msg   = String(args.message || '').trim();
        const phone = String(args.phone || '').trim();
        console.log(`[TS_AGENT] Take message: phone=${phone}, message=${msg}`);

        // Flag conversation as needing human attention
        if (conversationId) {
          await prisma.chatConversation.updateMany({
            where: { id: conversationId },
            data: { needsAttention: true, agentPaused: true },
          });
          console.log(`[TS_AGENT] Conversation ${conversationId} flagged as needsAttention`);
          void notifyMessaging({ conversationId, event: 'escalated' });
        }

        return { success: true, message: 'Message taken. The team has been notified and will get back to you shortly.' };
      }

      default:
        return { error: 'Unknown tool' };
    }
  } catch (error: any) {
    const errData = error.response?.data;
    console.error(`[TS_AGENT] Tool error (${name}):`, errData || error.message);
    return errData || { error: error.message || 'Tool execution failed' };
  }
}

// ---------------------------------------------------------------------------
// Booking creation — chains saveCustomer -> saveVehicle -> createSale
// ---------------------------------------------------------------------------

async function tsCreateBooking(
  args: any,
  session: TyresoftSession,
  cfg: TyresoftConfig,
  conversationId: string
): Promise<any> {
  const headers = tsHeaders(cfg);
  const base    = tsBaseUrl(cfg);

  // 1. Save customer
  const nameParts = String(args.customer_name).trim().split(/\s+/);
  const firstName = nameParts[0] || '';
  const lastName  = nameParts.slice(1).join(' ') || '';

  let customerID = 0;
  try {
    const custResp = await axios.post(`${base}/saveCustomer`, {
      customerID: 0,
      contactData: {
        name:    { firstName, lastName, salutation: '', company: '' },
        address: { addressLine1: '', addressLine2: '', addressLine3: '', addressLine4: '', city: '', county: '', postcode: args.customer_postcode || '', country: '', longitude: '', latitude: '' },
        contact: { mobile: args.customer_phone, email: args.customer_email || '', telephone: '' },
      },
      priceLevelID:  0,
      creditAccount: false,
      notes: 'Booked via ReceptionMate chat',
    }, { headers, timeout: 15000 });

    customerID = custResp.data?.customerID || 0;
    console.log(`[TS_AGENT] Customer saved: ${customerID}`);
  } catch (e: any) {
    console.error('[TS_AGENT] saveCustomer failed:', e.response?.data || e.message);
    return { error: 'Failed to save customer details. Please try again.' };
  }

  // 2. Save vehicle (if we captured it via VRM lookup)
  let vehicleID = 0;
  if (session.vrm && session.vehicle) {
    try {
      const v = session.vehicle;
      const tyreSizes = v.tyreSizeOptions?.[0] || {};
      const vehicleResp = await axios.post(`${base}/saveVehicle`, {
        vehicleID:  0,
        customerID,
        specifications: {
          vrm:                 session.vrm,
          make:                v.make                || '',
          model:               v.model               || '',
          yearOfManufacture:   v.yearOfManufacture   || v.year || '',
          colour:              v.colour              || '',
          vinSerialNo:         v.vinSerialNo         || '',
          dateFirstRegistered: v.dateFirstRegistered || '',
          engineCapacity:      v.engineCapacity      || '',
          transmission:        v.transmission        || '',
          fuel:                v.fuel                || '',
          doorplan:            v.doorplan            || '',
          motDue:              v.motDue              || '',
          taxDue:              v.taxDue              || '',
          tyreSizeOptions:     (v.tyreSizeOptions || []).map((t: any) => ({
            tyreSizeFront:    t.tyreSizeFront    || '',
            speedRatingFront: t.speedRatingFront || '',
            loadIndexFront:   t.loadIndexFront   || '',
            tyrePressureFront:t.tyrePressureFront|| '',
            tyreSizeRear:     t.tyreSizeRear     || '',
            speedRatingRear:  t.speedRatingRear  || '',
            loadIndexRear:    t.loadIndexRear    || '',
            tyrePressureRear: t.tyrePressureRear || '',
          })),
        },
        tyreSize: {
          tyreSizeFront:    tyreSizes.tyreSizeFront    || '',
          speedRatingFront: tyreSizes.speedRatingFront || '',
          loadIndexFront:   tyreSizes.loadIndexFront   || '',
          tyrePressureFront:tyreSizes.tyrePressureFront|| '',
          tyreSizeRear:     tyreSizes.tyreSizeRear     || '',
          speedRatingRear:  tyreSizes.speedRatingRear  || '',
          loadIndexRear:    tyreSizes.loadIndexRear    || '',
          tyrePressureRear: tyreSizes.tyrePressureRear || '',
        },
        flagData: { flagName: '', flagNotes: '' },
      }, { headers, timeout: 15000 });

      vehicleID = vehicleResp.data?.vehicleID || 0;
      console.log(`[TS_AGENT] Vehicle saved: ${vehicleID}`);
    } catch (e: any) {
      // Non-fatal — continue with vehicleID=0
      console.error('[TS_AGENT] saveVehicle failed (non-fatal):', e.response?.data || e.message);
    }
  }

  // 3. Build sale items — tyre basket takes priority over service_ids
  let items: any[];
  const tyreBasket = session.tyreBasket || [];

  if (tyreBasket.length > 0) {
    // Tyre booking — use stock number items (serviceID: 0)
    // Consolidate duplicate stock numbers (sum quantities) before building items
    const consolidatedTyres = tyreBasket.reduce((acc: Record<string, typeof tyreBasket[0]>, t) => {
      if (acc[t.stockNumber]) {
        acc[t.stockNumber] = { ...acc[t.stockNumber], quantity: acc[t.stockNumber].quantity + t.quantity };
      } else {
        acc[t.stockNumber] = { ...t };
      }
      return acc;
    }, {});
    items = Object.values(consolidatedTyres).map(t => ({
      saleLineID:                    0,
      productID:                     0,
      tyrecatID:                     0,
      productEANCode:                '',
      productManufacturerCode:       '',
      serviceID:                     0,
      shippingService:               false,
      incomeAccountID:               0,
      sequence:                      0,
      productItem:                   true,
      itemCode:                      t.stockNumber,
      itemDescription:               t.description,
      recordedDescription:           '',
      technicianID:                  0,
      quantity:                      t.quantity,
      unitCost:                      t.unitPrice,
      unitCostIncludesVAT:           true,
      discount:                      0,
      vatCodeID:                     0,
      backOrderQuantity:             0,
      taggedItemIdentifier:          '',
      linkLineID:                    0,
      hideChildLinks:                false,
      groupLinkSellPrices:           false,
      voucherCode:                   '',
      voucherCodeLine:               false,
      estimatedCost:                 0,
      protectEstimatedCost:          false,
      leadTime:                      t.leadTimeDays || 0,
      sourceSupplierID:              t.sourceSupplierID || 0,
      sourcePurchaseOrderID:         0,
      externalOrderLineReference:    '',
      changeInQtyAffectingPickList:  false,
      creditedAmount:                0,
    }));
    console.log(`[TS_AGENT] Building tyre sale: ${Object.keys(consolidatedTyres).length} consolidated line(s) from ${tyreBasket.length} basket item(s)`);
  } else {
    // Service booking — resolve price deterministically from tsServices/pricingRules, fall back to TYRESOFT_SERVICES
    items = (args.service_ids as number[]).map((sid) => {
      // Match by numeric ID: check tsServiceId/numeric id first, then TYRESOFT_SERVICES
      const tsSvc = cfg.tsServices?.find(s => svcNumericId(s) === sid);
      const fallbackSvc = TYRESOFT_SERVICES.find(s => s.id === sid);
      const code = tsSvc ? svcCode(tsSvc) : (fallbackSvc?.code ?? '');
      const name = tsSvc?.name ?? fallbackSvc?.name ?? '';

      // Deterministic price: use pricingRules if engine-size service
      let unitCost = tsSvc?.price ?? fallbackSvc?.price ?? 0;
      if (tsSvc?.pricingType === 'engine-size' && cfg.pricingRules && session.vehicle?.engineCapacity) {
        const deterministicPrice = getServicePriceForEngine(
          svcCode(tsSvc),
          Number(session.vehicle.engineCapacity),
          cfg.pricingRules
        );
        if (deterministicPrice !== null) {
          console.log(`[TS_AGENT] Deterministic price for ${svcCode(tsSvc)} @ ${session.vehicle.engineCapacity}cc → £${deterministicPrice}`);
          unitCost = deterministicPrice;
        }
      }

      return {
        saleLineID:          0,
        productID:           0,
        serviceID:           sid,
        itemCode:            code,
        itemDescription:     name,
        quantity:            1,
        unitCost,
        unitCostIncludesVAT: true,
        discount:            0,
      };
    });
  }

  // 4. Resolve slot metadata from session (never trust LLM for diaryCategoryID)
  let slotDate = args.slot_date;
  let slotTime = args.slot_time;
  let diaryCategoryID: number;
  let estimatedTime: number;
  let slotTypeID: number;
  if (session.availableSlots?.length) {
    let match = session.availableSlots.find(s => s.date === slotDate && s.time === slotTime);
    if (!match) match = session.availableSlots.find(s => s.time === slotTime);
    if (!match) match = session.availableSlots[0];
    if (match) {
      if (match.date !== slotDate) {
        console.warn(`[TS_AGENT] Date mismatch: LLM sent ${slotDate} but slot is ${match.date}. Correcting.`);
        slotDate = match.date;
      }
      diaryCategoryID = match.diaryCategoryID;
      estimatedTime   = match.estimatedTime;
      slotTypeID      = match.slotTypeID;
    } else {
      console.error(`[TS_AGENT] No slot match found in session — aborting to prevent wrong diary booking`);
      return { error: 'slot_not_found', message: 'Could not resolve slot details. Please re-select a time slot.' };
    }
  } else {
    console.error(`[TS_AGENT] No available slots in session — aborting to prevent wrong diary booking`);
    return { error: 'no_slots_in_session', message: 'No slot data available. Please call ts_get_timeslots first.' };
  }
  console.log(`[TS_AGENT] Slot resolved: ${slotDate} ${slotTime} → diary=${diaryCategoryID}, est=${estimatedTime}, type=${slotTypeID}`);

  // 5. Create sale
  try {
    const saleResp = await axios.post(`${base}/createSale`, {
      depotID:     cfg.depotId,
      customerID,
      vehicleID,
      saleDate:    slotDate,
      saleStatus:  'Order',
      notes:       'Booked via ReceptionMate chat agent',
      poNumber:    '',
      flag:        0,
      flagNotes:   '',
      channelID:   cfg.channelId ?? 24, // ReceptionMate API channel (per-garage override)
      orderStatus: 'Awaiting Acknowledgement',
      bookingSlot: {
        date:            slotDate,
        time:            slotTime,
        diaryCategoryID,
        estimatedTime,
        slotTypeID,
      },
      items,
      payments:      [{ paymentMethodID: 0, leaveUnallocated: true }],
      customValues:  [],
      customGroupID: 0,
    }, { headers, timeout: 20000 });

    console.log(`[TS_AGENT] Sale created: saleID=${saleResp.data?.saleID}, saleNumber=${saleResp.data?.saleNumber}`);

    // Structured booking log — mirrors voice agent [BOOKING CREATED] format
    const itemSummary = tyreBasket.length > 0
      ? Object.values(session.tyreBasket!.reduce((acc: Record<string, any>, t) => {
          acc[t.stockNumber] = acc[t.stockNumber]
            ? { ...acc[t.stockNumber], quantity: acc[t.stockNumber].quantity + t.quantity }
            : { ...t };
          return acc;
        }, {})).map((t: any) => `${t.quantity}x ${t.description} @ £${t.unitPrice}`).join(', ')
      : (args.service_ids as number[]).map((sid: number) => {
          const svc = cfg.tsServices?.find(s => svcNumericId(s) === sid) ?? TYRESOFT_SERVICES.find(s => s.id === sid);
          return svc ? svc.name : `serviceID=${sid}`;
        }).join(', ');

    console.log(`[BOOKING CREATED] ${JSON.stringify({
      timestamp:   new Date().toUTCString(),
      channel:     'chat',
      reference:   `TS-${saleResp.data?.saleNumber}`,
      sale_id:     saleResp.data?.saleID,
      sale_number: saleResp.data?.saleNumber,
      customer:    session.customerName  || '',
      phone:       session.customerPhone || '',
      vrm:         session.vrm           || '',
      vehicle:     session.vehicle ? `${session.vehicle.make} ${session.vehicle.model}` : '',
      branch:      cfg.depotId,
      date:        slotDate,
      time:        slotTime,
      items:       itemSummary,
    })}`);

    // Back order check — flag if any tyre needs ordering in
    const backOrderItems = tyreBasket.filter(item => {
      const found = (session.lastTyreSearch || []).find(t => t.stock_number === item.stockNumber);
      if (!found) return false;
      const avail    = (found.availability || '').toLowerCase();
      const leadTime = (found.lead_time    || '').trim();
      return avail.includes('back') || avail.includes('order') || (leadTime !== '' && leadTime !== '0');
    });
    const hasBackOrder = backOrderItems.length > 0;

    // Clear session on success
    tsSessions.delete(conversationId);

    return {
      success:          true,
      saleID:           saleResp.data?.saleID,
      saleNumber:       saleResp.data?.saleNumber,
      customerID,
      vehicleID,
      back_order:       hasBackOrder,
      back_order_note:  hasBackOrder
        ? 'Some tyres will need to be ordered in but will be ready for your appointment.'
        : null,
    };
  } catch (e: any) {
    console.error('[TS_AGENT] createSale failed:', e.response?.data || e.message);
    return { error: 'Failed to create booking', details: e.response?.data };
  }
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(
  config: any,
  knowledgeDocs: any[],
  isOpen: boolean,
  session: TyresoftSession,
  hasCreds: boolean,
  humanEscalation: boolean,
  tsConfig?: TyresoftConfig
): string {
  const branchName = config.branchName || 'our garage';
  const agentName = (config.agentName || '').trim();
  const who = agentName ? `${agentName}, a friendly receptionist` : 'a friendly receptionist';

  let prompt = `You are ${who} at ${branchName}, a tyre and vehicle service centre. ${config.greetingLine || ''}\n\n`;
  prompt += `HOW YOU TALK — like a real person texting, NOT an essay:\n`;
  prompt += `- Keep every reply to ONE or two SHORT sentences. Never send a paragraph — a real person wouldn't.\n`;
  prompt += `- Warm, natural, British English (tyre, kerb, MOT; "brilliant", "no worries", "cheers"). One question at a time.\n`;
  prompt += `- No lists or bullet points. No corporate filler ("Certainly!", "Of course!", "Great!"). Never sound like a bot.\n\n`;

  prompt += `About us:\n`;
  if (config.branchAddress) prompt += `Address: ${config.branchAddress}\n`;
  if (config.phoneNumber)   prompt += `Phone: ${config.phoneNumber}\n`;
  if (config.emailAddress)  prompt += `Email: ${config.emailAddress}\n`;
  if (config.websiteUrl)    prompt += `Website: ${config.websiteUrl}\n`;
  prompt += `\n`;

  if (config.weeklyOpeningHours) {
    prompt += `Opening hours:\n`;
    const hours = config.weeklyOpeningHours as Record<string, any>;
    for (const [day, times] of Object.entries(hours)) {
      if (times && typeof times === 'object' && 'open' in times && 'close' in times) {
        const d = day.charAt(0).toUpperCase() + day.slice(1);
        prompt += `${d}: ${times.open} - ${times.close}\n`;
      }
    }
    prompt += `\nWe're currently ${isOpen ? 'OPEN' : 'CLOSED'}.\n\n`;
  }

  if (knowledgeDocs.length) {
    prompt += `Additional info:\n`;
    for (const doc of knowledgeDocs) {
      if (doc.title) prompt += `${doc.title}:\n`;
      prompt += `${doc.content}\n\n`;
    }
  }

  // ── Per-garage config: custom rules, FAQs, smart questions (parity with the voice agents) ──
  const _rules = Array.isArray(config.customRules)
    ? config.customRules
        .filter((r: any) => r && typeof r === 'object' && r.active === true && (r.text || '').trim())
        .map((r: any) => `- ${String(r.text).trim()}`)
    : [];
  if (_rules.length > 0) {
    prompt += `RULES YOU MUST FOLLOW (these override anything else in this prompt):\n${_rules.join('\n')}\n\n`;
  }

  const _faqs = Array.isArray(config.faqs)
    ? config.faqs
        .filter((f: any) => f && (f.question || f.q) && (f.answer || f.a))
        .map((f: any) => `Q: ${String(f.question || f.q).trim()}\nA: ${String(f.answer || f.a).trim()}`)
    : [];
  if (_faqs.length > 0) {
    prompt += `COMMON QUESTIONS — answer from these when a customer asks something similar; do NOT invent an answer:\n${_faqs.join('\n')}\n\n`;
  }

  const _fields = Array.isArray(config.dataCollectionFields)
    ? config.dataCollectionFields
        .filter((f: any) => f && f.active === true && (f.label || f.key))
        .map((f: any) => {
          const label = String(f.label || f.key).trim();
          const tag = f.required ? '(required)' : '(only if relevant)';
          const instr = (f.instruction || '').trim() ? ` — ${String(f.instruction).trim()}` : '';
          return `- ${label} ${tag}${instr}`;
        })
    : [];
  if (_fields.length > 0) {
    prompt += `INFORMATION TO COLLECT during the chat (ask naturally, one at a time, don't interrogate):\n${_fields.join('\n')}\n\n`;
  }

  if (hasCreds) {
    prompt += `\nBOOKING FLOW:\n\n`;

    prompt += `TYRE BOOKING (customer wants new tyres):\n`;
    prompt += `1. Ask for their vehicle registration and call ts_lookup_vehicle.\n`;
    prompt += `2. After ts_lookup_vehicle, confirm the vehicle: "I can see that's a [year] [make] [model] — is that correct?"\n`;
    prompt += `   Only continue once they confirm. If they say no, ask them to re-check their plate.\n`;
    prompt += `3. Use tyreSizeOptions[0].tyreSizeFront from the lookup as the tyre size — strip any load index or speed rating (e.g. use "235/60R18" not "235/60R18 107V").\n`;
    prompt += `4. Call ts_search_tyres with that size to find available tyres.\n`;
    prompt += `5. Present options as a numbered list (brand, price per tyre). Ask how many they need — typically 1, 2, or 4.\n`;
    prompt += `6. Customer picks one — call ts_add_tyre_to_basket with stock_number, quantity, unit_price, description.\n`;
    prompt += `7. Call ts_get_timeslots with service_ids=[0] (0 = tyre fitting).\n`;
    prompt += `8. Offer 3-4 slots. If the customer states a time preference (e.g. "around 10", "morning"), call ts_check_preferred_time before listing slots.\n`;
    prompt += `9. When customer picks a slot, immediately call ts_confirm_slot to save it.\n`;
    prompt += `10. Ask for name + phone number if not already saved. Once you have both, call ts_save_customer_details immediately.\n`;
    prompt += `11. Read back the summary: "[quantity] x [tyre description] on [date] at [time] for [name] — shall I confirm?"\n`;
    prompt += `12. Call ts_create_booking with service_ids=[0] only after explicit YES.\n\n`;

    prompt += `SERVICE BOOKING (MOT, full service, alignment, air con, etc.):\n`;
    prompt += `1. ALWAYS ask for their vehicle registration plate FIRST and call ts_lookup_vehicle before anything else.\n`;
    prompt += `   The VRM lookup returns engineCapacity — use it to auto-select the correct service tier. Never ask the customer for engine size manually.\n`;
    prompt += `2. After ts_lookup_vehicle, confirm the vehicle: "I can see that's a [year] [make] [model] — is that correct?"\n`;
    prompt += `   Only continue once they confirm. If they say no, ask them to re-check their plate.\n`;
    prompt += `3. Call ts_get_services to match the customer's request.\n`;
    prompt += `   If the service shows "Varies by engine size", call ts_get_service_price using the EXACT service code from ts_get_services (copy it verbatim — e.g. "FULL_SERVICE", never abbreviate to "FS") and engineCapacity from the VRM lookup, to get the exact price before quoting it.\n`;
    prompt += `   Never quote a price for engine-size services without calling ts_get_service_price first.\n`;
    prompt += `4. Call ts_get_timeslots with the correct service_id(s).\n`;
    prompt += `5. Offer 3-4 slots. If the customer states a time preference, call ts_check_preferred_time before listing slots.\n`;
    prompt += `6. When customer picks a slot, immediately call ts_confirm_slot to save it.\n`;
    prompt += `7. Collect name + phone (call ts_save_customer_details once you have both).\n`;
    prompt += `8. Read back summary and confirm — call ts_create_booking only after YES.\n\n`;

    prompt += `MULTI-ITEM TRACKING:\n`;
    prompt += `- If the customer wants MULTIPLE items (e.g. "tyres AND an MOT", "alignment and air con"), track ALL of them throughout the conversation.\n`;
    prompt += `- Add each service to the relevant basket or service list before fetching slots.\n`;
    prompt += `- Do NOT lose track of earlier items when the customer confirms later ones.\n`;
    prompt += `- CRITICAL: Even in a combined tyre + service request, you MUST still present tyre options and wait for the customer to choose before calling ts_add_tyre_to_basket. Never auto-select a tyre — always let the customer pick.\n\n`;

    prompt += `BRANCH / LOCATION:\n`;
    prompt += `- If the customer asks about a different branch or location, call ts_set_branch.\n`;
    prompt += `- After switching branch, tyre searches and available slots reset automatically — search again for the new branch.\n\n`;

    prompt += `RULES:\n`;
    prompt += `- After ts_create_booking succeeds:\n`;
    prompt += `  If back_order is true in the response, say: "You're all booked in! Reference #[saleNumber]. Just to let you know, we'll need to order your tyres in — they'll be ready for your appointment. We'll see you on [date] at [time]. Is there anything else I can help with?"\n`;
    prompt += `  Otherwise say: "You're all booked in! Your reference number is #[saleNumber] — please quote this when you arrive. We'll see you on [date] at [time] for your [service]. Is there anything else I can help with?"\n`;
    prompt += `- Never call ts_create_booking without explicit customer confirmation.\n`;
    prompt += `- Never re-run ts_lookup_vehicle if already done in this session.\n`;
    prompt += `- Never ask for information already saved in the session (name, phone, VRM, basket).\n`;
    prompt += `- If tyre size not found in vehicle data, ask the customer directly: "What size tyres does your car take?"\n`;
    prompt += `- If no slots match the customer's preference, call ts_list_all_slots to show all available times.\n`;
    prompt += `- CRITICAL: When a customer provides their name, phone number, time preference, or any other information you asked for, do NOT greet them or start over. Continue the booking flow immediately from where you left off.\n`;
    prompt += `- CRITICAL: If the customer gives only their name and you still need their phone number, say "Thanks [name] — and what's the best number to reach you on?" Do NOT say "Hello [name]! How can I assist you today?"\n`;
    prompt += `- Keep replies concise — 1 to 3 sentences max.\n`;
    prompt += `- Never use markdown: no **bold**, no bullet points, no dashes. Plain sentences only.\n`;
    prompt += `- When listing tyre options, write them as a short numbered plain-text list with name and price only.\n`;
    prompt += `  Example: "1. Radar RPX-800+ — £49.26 per tyre\\n2. Zeta Impero XL — £56.67 per tyre"\n`;
    prompt += `- When presenting available time slots, write them as a natural sentence, not a bullet list.\n`;
    prompt += `  Example: "I have 12:30 PM, 1:00 PM, 1:30 PM or 3:30 PM available on March 19th — which works best for you?"\n`;
    if (humanEscalation) {
      prompt += `- If the customer wants to speak to a human or leave a message:\n`;
      prompt += `  Ask what their message is and confirm you have their phone number.\n`;
      prompt += `  Call ts_take_message, then tell them: "I've passed your message on to the team. Someone will get back to you shortly."\n`;
      prompt += `  Do NOT continue trying to help after ts_take_message — the conversation is handed off.\n`;
      prompt += `- If the customer explicitly asks to be called back (e.g. "can someone ring me?"):\n`;
      prompt += `  Ask for their name and best number if not already known.\n`;
      prompt += `  Call ts_request_callback, then tell them: "No problem — I've logged a callback request and someone will give you a ring shortly."\n\n`;
    } else {
      const custom = ((config as any).messagingHandoffMessage || '').trim();
      if (custom) {
        prompt += `- You CANNOT take messages, pass details to the team, or arrange callbacks — no one is available over chat. If the customer wants a human, to leave a message, or a callback, do NOT offer to; instead reply with this exact message: "${custom}". You can still answer their questions and book them in.\n\n`;
      } else {
        const esc = [config.phoneNumber ? `phone ${config.phoneNumber}` : '', config.emailAddress ? `email ${config.emailAddress}` : ''].filter(Boolean).join(' or ');
        prompt += `- You CANNOT take messages, pass details to the team, or arrange callbacks — no one is available over chat. If the customer wants to speak to a human, leave a message, or asks for a callback, do NOT offer to; instead tell them to contact us directly${esc ? ` on ${esc}` : ''}. You can still answer their questions and book them in.\n\n`;
      }
    }

    // Active session context — show whenever there is ANY booking state
    const hasSessionState = !!(session.vrm || session.serviceIds?.length || session.tyreBasket?.length || session.customerName || session.customerPhone || session.availableSlots?.length || session.selectedSlot || session.branchOverride);
    if (hasSessionState) {
      prompt += `ACTIVE SESSION (do NOT ask for information already listed here):\n`;
      if (session.vrm) {
        prompt += `- Vehicle reg: ${session.vrm}`;
        if (session.vehicle?.make) prompt += ` (${session.vehicle.make} ${session.vehicle.model})`;
        prompt += ` — do NOT call ts_lookup_vehicle again\n`;
      }
      if (session.serviceIds?.length) {
        const serviceNames = session.serviceIds.map(id => {
          const svc = tsConfig?.tsServices?.find(s => svcNumericId(s) === id) ?? TYRESOFT_SERVICES.find(s => s.id === id);
          return svc?.name || `ID ${id}`;
        }).join(', ');
        prompt += `- Service selected: ${serviceNames} (IDs: ${session.serviceIds.join(', ')})\n`;
      }
      if (session.tyreBasket?.length) {
        const total = session.tyreBasket.reduce((s, i) => s + i.quantity * i.unitPrice, 0);
        prompt += `- Tyre basket: ${session.tyreBasket.map(i => `${i.quantity}x ${i.description} @ £${i.unitPrice}`).join(', ')} (total £${total.toFixed(2)})\n`;
      }
      if (session.availableSlots?.length && !session.selectedSlot) {
        const slotSummary = session.availableSlots.slice(0, 5).map(s => `${s.date} ${s.time}`).join(', ');
        prompt += `- Available slots already fetched (${slotSummary}) — do NOT call ts_get_timeslots again\n`;
      }
      if (session.selectedSlot) {
        prompt += `- Selected slot: ${session.selectedSlot.date} at ${session.selectedSlot.time} — do NOT ask for time again\n`;
      }
      if (session.customerName)  prompt += `- Customer name: ${session.customerName} — already collected, do NOT ask again\n`;
      if (session.customerPhone) prompt += `- Customer phone: ${session.customerPhone} — already collected, do NOT ask again\n`;
      if (session.branchOverride) {
        const branchNum = session.branchOverride === 3 ? 2 : 1;
        prompt += `- Active branch: Branch ${branchNum} (depot ${session.branchOverride}) — do NOT call ts_set_branch again\n`;
      }
      prompt += `\n`;
    }
  } else {
    const phone = config.phoneNumber ? ` (${config.phoneNumber})` : '';
    const web   = config.websiteUrl  ? ` at ${config.websiteUrl}`  : '';
    prompt += `\nFor bookings, please direct customers to call us${phone} or visit our website${web}.\n\n`;
  }

  prompt += `STYLE: Warm, natural, and human. Keep it short — 1 to 2 sentences unless more detail is needed. Avoid corporate language.\n`;

  return prompt;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function checkOpeningHours(weeklyOpeningHours: any): boolean {
  if (!weeklyOpeningHours || typeof weeklyOpeningHours !== 'object') return true;
  const now  = new Date();
  const day  = now.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
  const time = now.toTimeString().slice(0, 5);
  const h    = (weeklyOpeningHours as Record<string, any>)[day];
  if (!h?.open || !h?.close) return false;
  return time >= h.open && time <= h.close;
}
