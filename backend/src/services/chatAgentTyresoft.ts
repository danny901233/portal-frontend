import { prisma } from '../db.js';
import OpenAI from 'openai';
import axios from 'axios';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Lazy-load OpenAI client
let openaiClient: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!openaiClient) {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured');
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openaiClient;
}

interface ChatAgentResponse {
  content: string;
  needsHumanAssistance?: boolean;
}

interface TyresoftConfig {
  workspace: string;
  username: string;
  password: string;
  apiKey: string;
  depotId: number;
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
}

interface TyreBasketItem {
  stockNumber: string;
  quantity: number;
  unitPrice: number;
  description: string;
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
  lastTyreSearch?: { stock_number: string; description: string; price: number }[];
}

// ---------------------------------------------------------------------------
// Tyre inventory — loaded from CSV at startup
// ---------------------------------------------------------------------------

const TYRE_INVENTORY = new Map<number, TyreProduct[]>();

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
      availability: cols[iAvail]?.trim()     ?? '',
      leadTime:     cols[iLeadTime]?.trim()  ?? '',
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
    let tsConfig: TyresoftConfig | undefined;
    if (config.integrationProviderConfig && typeof config.integrationProviderConfig === 'object') {
      const raw = config.integrationProviderConfig as any;
      const workspace = raw.tsWorkspace || raw.workspace || '';
      const username  = raw.tsUsername  || raw.username  || '';
      const password  = raw.tsPassword  || raw.password  || '';
      const apiKey    = raw.tsApiKey    || raw.apiKey    || '';
      const depotId   = Number(raw.tsDepotId || raw.depotId || 1);
      if (workspace && username && password && apiKey) {
        tsConfig = { workspace, username, password, apiKey, depotId };
      }
    }

    console.log('[TS_AGENT] Config loaded:', { garageId, hasApiCreds: !!tsConfig });

    const isOpen    = checkOpeningHours(config.weeklyOpeningHours);
    const session   = tsSessions.get(conversationId) || {};
    const tools     = buildTools(!!tsConfig);
    const sysPrompt = buildSystemPrompt(config, garage.knowledgeDocuments, isOpen, session, !!tsConfig);

    // Build message history
    const previousMessages = (await prisma.chatMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })).reverse();

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: sysPrompt },
    ];

    for (const msg of previousMessages) {
      messages.push({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: msg.content,
      });
    }

    // Inject seed contact context on first message
    let userContent = message;
    if (seedContact && previousMessages.length === 0) {
      const hints: string[] = [];
      if (seedContact.name)  hints.push(`[Customer name: ${seedContact.name}]`);
      if (seedContact.phone) hints.push(`[Customer phone: ${seedContact.phone}]`);
      if (hints.length) userContent = `${hints.join(' ')} ${message}`;
    }
    messages.push({ role: 'user', content: userContent });

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

        const result = await executeTool(call.function.name, args, conversationId, tsConfig);
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

function buildTools(hasCreds: boolean): OpenAI.Chat.ChatCompletionTool[] {
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
        description: 'Look up a vehicle by registration plate to confirm make/model and get default tyre sizes. Call once you have the reg.',
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
        description: 'Add a selected tyre to the customer basket. Call after the customer has chosen a specific tyre from the search results.',
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
      case 'ts_get_services':
        return { services: TYRESOFT_SERVICES };

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
        const size  = String(args.size || '');
        const brand = args.brand ? String(args.brand) : undefined;
        const results = searchTyres(tsConfig.depotId, size, brand);
        if (results.length === 0) {
          return {
            found: 0,
            message: `No tyres found for size ${size}${brand ? ` (brand: ${brand})` : ''}. Try a different size or omit the brand filter.`,
          };
        }
        const tyreList = results.map((t, i) => ({
          stock_number: t.stockNumber,
          description:  t.title,
          brand:        t.brand,
          price:        t.price,
          availability: t.availability || 'In Stock',
          lead_time:    t.leadTime,
          runflat:      t.runflat,
          _index:       i + 1,
        }));
        // Store real stock codes in session so they can't be hallucinated
        tsSessions.set(conversationId, {
          ...session,
          lastTyreSearch: tyreList.map(t => ({ stock_number: t.stock_number, description: t.description, price: t.price })),
        });
        console.log(`[TS_AGENT] Tyre search: size=${size}, brand=${brand}, found=${results.length}`);
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
          stockNumber: resolvedStockNumber,
          quantity:    Number(args.quantity) || 4,
          unitPrice:   resolvedPrice,
          description: resolvedDescription,
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

        // Server-side guardrail: full service tiers require a prior VRM lookup
        const FULL_SERVICE_IDS = [2, 57, 8]; // FS1, FS2, FS3
        const requestedIds: number[] = args.service_ids || [];
        if (requestedIds.some(id => FULL_SERVICE_IDS.includes(id)) && !session.vrm) {
          return {
            error: 'vehicle_registration_required',
            directive:
              'A full service tier depends on engine size. Ask the customer for their registration plate and call ts_lookup_vehicle first, then select the correct tier automatically from engineCapacity.',
          };
        }

        const startDate = args.start_date || getTomorrow();
        const resp = await axios.post(
          `${tsBaseUrl(tsConfig)}/availableSlotsForBasket/${tsConfig.depotId}/${startDate}`,
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
      leadTime:                      0,
      sourceSupplierID:              0,
      sourcePurchaseOrderID:         0,
      externalOrderLineReference:    '',
      changeInQtyAffectingPickList:  false,
      creditedAmount:                0,
    }));
    console.log(`[TS_AGENT] Building tyre sale: ${Object.keys(consolidatedTyres).length} consolidated line(s) from ${tyreBasket.length} basket item(s)`);
  } else {
    // Service booking — look up price from TYRESOFT_SERVICES by service ID
    items = (args.service_ids as number[]).map((sid) => {
      const svc = TYRESOFT_SERVICES.find((s) => s.id === sid);
      return {
        saleLineID:           0,
        productID:            0,
        serviceID:            sid,
        itemCode:             svc?.code ?? '',
        itemDescription:      svc?.name ?? '',
        quantity:             1,
        unitCost:             svc?.price ?? 0,
        unitCostIncludesVAT:  true,
        discount:             0,
      };
    });
  }

  // 4. Resolve slot metadata from session (never trust LLM for diaryCategoryID)
  let slotDate = args.slot_date;
  let slotTime = args.slot_time;
  let diaryCategoryID = 1;
  let estimatedTime = 30;
  let slotTypeID = 1;
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
    }
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
      channelID:   24, // ReceptionMate API channel
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

    // Clear session on success
    tsSessions.delete(conversationId);

    return {
      success:    true,
      saleID:     saleResp.data?.saleID,
      saleNumber: saleResp.data?.saleNumber,
      customerID,
      vehicleID,
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
  hasCreds: boolean
): string {
  const branchName = config.branchName || 'our garage';

  let prompt = `You are a friendly receptionist at ${branchName}, a tyre and vehicle service centre. ${config.greetingLine || ''}\n\n`;

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

  if (hasCreds) {
    prompt += `\nBOOKING FLOW:\n\n`;

    prompt += `TYRE BOOKING (customer wants new tyres):\n`;
    prompt += `1. Ask for their vehicle registration and call ts_lookup_vehicle.\n`;
    prompt += `2. After ts_lookup_vehicle, confirm the vehicle with the customer before proceeding.\n`;
    prompt += `   Say: "I can see that's a [year] [make] [model] — is that correct?"\n`;
    prompt += `   Only continue once they confirm. If they say no, ask them to re-check their plate.\n`;
    prompt += `3. Use tyreSizeOptions[0].tyreSizeFront from the lookup as the tyre size — strip any load index or speed rating (e.g. use "235/60R18" not "235/60R18 107V").\n`;
    prompt += `4. Call ts_search_tyres with that size to find available tyres.\n`;
    prompt += `5. Present options: brand, price per tyre, availability. Ask how many they need (1, 2, or 4).\n`;
    prompt += `6. Customer picks one — call ts_add_tyre_to_basket with stock_number, quantity, unit_price, description.\n`;
    prompt += `7. Call ts_get_timeslots with service_ids=[0] (0 = tyre fitting).\n`;
    prompt += `8. Offer 3-4 slots in plain language.\n`;
    prompt += `9. When customer picks a slot, immediately call ts_confirm_slot to save it.\n`;
    prompt += `10. Ask for name + phone number if not already saved. Once you have both, call ts_save_customer_details immediately.\n`;
    prompt += `10. Read back the summary: "[quantity] x [tyre description] on [date] at [time] for [name] — shall I confirm?"\n`;
    prompt += `11. Call ts_create_booking with service_ids=[0] only after explicit YES.\n\n`;

    prompt += `SERVICE BOOKING (MOT, full service, alignment, air con, etc.):\n`;
    prompt += `1. ALWAYS ask for their vehicle registration plate FIRST and call ts_lookup_vehicle before anything else.\n`;
    prompt += `   Do NOT ask about engine size, service tier, or anything else before doing the VRM lookup.\n`;
    prompt += `   The VRM lookup returns engineCapacity — use it to auto-select the correct service tier.\n`;
    prompt += `   Never ask the customer for engine size manually.\n`;
    prompt += `2. After ts_lookup_vehicle, confirm the vehicle with the customer before proceeding.\n`;
    prompt += `   Say: "I can see that's a [year] [make] [model] — is that correct?"\n`;
    prompt += `   Only continue once they confirm. If they say no, ask them to re-check their plate.\n`;
    prompt += `3. Call ts_get_services to match the customer's request using engineCapacity from the VRM lookup.\n`;
    prompt += `4. Call ts_get_timeslots with the correct service_id(s).\n`;
    prompt += `5. Offer 3-4 slots in plain language.\n`;
    prompt += `6. When customer picks a slot, immediately call ts_confirm_slot to save it.\n`;
    prompt += `7. Collect name + phone (call ts_save_customer_details once you have both).\n`;
    prompt += `8. Read back summary and confirm — call ts_create_booking only after YES.\n\n`;

    prompt += `RULES:\n`;
    prompt += `- After ts_create_booking succeeds, always end with a confirmation message like:\n`;
    prompt += `  "You're all booked in! Your reference number is #[saleNumber] — please quote this when you arrive. We'll see you on [date] at [time] for your [service]. Is there anything else I can help with?"\n`;
    prompt += `- Never call ts_create_booking without explicit customer confirmation.\n`;
    prompt += `- Never re-run ts_lookup_vehicle if already done in this session.\n`;
    prompt += `- Never ask for information already saved in the session (name, phone, VRM, basket).\n`;
    prompt += `- If tyre size not found in vehicle data, ask the customer directly (e.g. "What size tyres does your car take?").\n`;
    prompt += `- CRITICAL: When a customer provides their name, phone number, time preference, or any other information you asked for, do NOT greet them or start over. Continue the booking flow immediately from where you left off.\n`;
    prompt += `- CRITICAL: If the customer gives only their name and you still need their phone number, say "Thanks [name] — and what's the best number to reach you on?" Do NOT say "Hello [name]! How can I assist you today?"\n`;
    prompt += `- Keep replies concise — 1 to 3 sentences max.\n`;
    prompt += `- Never use markdown: no **bold**, no bullet points, no dashes. Plain sentences only.\n`;
    prompt += `- When listing tyre options, write them as a short numbered plain-text list with name and price only.\n`;
    prompt += `  Example: "1. Radar RPX-800+ — £49.26 per tyre\\n2. Zeta Impero XL — £56.67 per tyre"\n`;
    prompt += `- When presenting available time slots, write them as a natural sentence, not a bullet list.\n`;
    prompt += `  Example: "I have 12:30 PM, 1:00 PM, 1:30 PM or 3:30 PM available on March 19th — which works best for you?"\n`;
    prompt += `- If the customer asks to speak to a human, real person, or staff member, or says they want to leave a message:\n`;
    prompt += `  First ask what their message is and confirm you have their phone number (use saved phone if available).\n`;
    prompt += `  Then call ts_take_message with their message and phone number.\n`;
    prompt += `  After calling ts_take_message, tell them: "I've passed your message on to the team. Someone will get back to you shortly."\n`;
    prompt += `  Do NOT continue trying to help after ts_take_message is called — the conversation is handed off.\n\n`;

    // Active session context — show whenever there is ANY booking state
    const hasSessionState = !!(session.vrm || session.serviceIds?.length || session.tyreBasket?.length || session.customerName || session.customerPhone || session.availableSlots?.length || session.selectedSlot);
    if (hasSessionState) {
      prompt += `ACTIVE SESSION (do NOT ask for information already listed here):\n`;
      if (session.vrm) {
        prompt += `- Vehicle reg: ${session.vrm}`;
        if (session.vehicle?.make) prompt += ` (${session.vehicle.make} ${session.vehicle.model})`;
        prompt += ` — do NOT call ts_lookup_vehicle again\n`;
      }
      if (session.serviceIds?.length) {
        const serviceNames = session.serviceIds.map(id => TYRESOFT_SERVICES.find(s => s.id === id)?.name || `ID ${id}`).join(', ');
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
