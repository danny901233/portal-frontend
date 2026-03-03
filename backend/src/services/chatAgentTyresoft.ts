import { prisma } from '../db.js';
import OpenAI from 'openai';
import axios from 'axios';

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

interface TyresoftSession {
  vrm?: string;
  vehicle?: any;
  serviceIds?: number[];
  serviceName?: string;
}

// In-memory session state (per conversation)
const tsSessions = new Map<string, TyresoftSession>();

// Static service catalogue (matches Tyresoft voice agent configuration)
const TYRESOFT_SERVICES = [
  { id: 3,  code: 'WA',   name: 'Wheel Alignment',               price: 47.99  },
  { id: 11, code: 'AIR1', name: 'Air Con Recharge',              price: 84.00  },
  { id: 2,  code: 'FS1',  name: 'Full Service (up to 1600cc)',   price: 132.00 },
  { id: 57, code: 'FS2',  name: 'Full Service (1601–2000cc)',    price: 154.00 },
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

    const isOpen   = checkOpeningHours(config.weeklyOpeningHours);
    const session  = tsSessions.get(conversationId) || {};
    const tools    = buildTools(!!tsConfig);
    const sysPrompt = buildSystemPrompt(config, garage.knowledgeDocuments, isOpen, session, !!tsConfig);

    // Build message history
    const previousMessages = await prisma.chatMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
      take: 8,
    });

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

    const temperature = session.serviceIds?.length ? 0.5 : 0.9;

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
        const args = JSON.parse(call.function.arguments);
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
        description: 'Return the list of bookable services with prices. Call when the customer asks what services are available or wants to book.',
        parameters: { type: 'object', properties: {} },
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
        name: 'ts_get_timeslots',
        description: 'Fetch available booking timeslots. Call after the customer has confirmed their vehicle and chosen a service.',
        parameters: {
          type: 'object',
          properties: {
            service_ids: {
              type: 'array',
              items: { type: 'number' },
              description: 'Tyresoft service IDs to book (e.g. [3] for wheel alignment, [58] for MOT, [0] for tyres).',
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
        description: 'Create the booking after the customer has explicitly confirmed all details. Saves customer, vehicle, and creates the sale.',
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
              description: 'Service IDs being booked (same as used in ts_get_timeslots)',
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
        tsSessions.set(conversationId, { ...session, vrm, vehicle });
        console.log(`[TS_AGENT] VRM lookup OK: ${vrm} → ${vehicle.make} ${vehicle.model} (${vehicle.yearOfManufacture || vehicle.year})`);
        return vehicle;
      }

      case 'ts_get_timeslots': {
        if (!tsConfig) return { error: 'Tyresoft API not configured for this garage' };
        const startDate = args.start_date || getTomorrow();
        const resp = await axios.post(
          `${tsBaseUrl(tsConfig)}/availableSlotsForBasket/${tsConfig.depotId}/${startDate}`,
          { list: args.service_ids },
          { headers: tsHeaders(tsConfig), timeout: 15000 }
        );
        tsSessions.set(conversationId, { ...session, serviceIds: args.service_ids });
        console.log(`[TS_AGENT] Timeslots fetched for service_ids=${JSON.stringify(args.service_ids)}, date=${startDate}`);
        return resp.data;
      }

      case 'ts_create_booking': {
        if (!tsConfig) return { error: 'Tyresoft API not configured for this garage' };
        return await tsCreateBooking(args, session, tsConfig, conversationId);
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
// Booking creation — chains saveCustomer → saveVehicle → createSale
// ---------------------------------------------------------------------------

async function tsCreateBooking(
  args: any,
  session: TyresoftSession,
  cfg: TyresoftConfig,
  conversationId: string
): Promise<any> {
  const headers = tsHeaders(cfg);
  const base = tsBaseUrl(cfg);

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
        address: { postcode: args.customer_postcode || '', city: '', street1: '', street2: '' },
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
          vrm:                session.vrm,
          make:               v.make               || '',
          model:              v.model              || '',
          yearOfManufacture:  v.yearOfManufacture  || v.year || '',
          colour:             v.colour             || '',
          vinSerialNo:        v.vinSerialNo        || '',
          dateFirstRegistered:v.dateFirstRegistered|| '',
          engineCapacity:     v.engineCapacity     || '',
          transmission:       v.transmission       || '',
          fuel:               v.fuel               || '',
          doorplan:           v.doorplan           || '',
          motDue:             v.motDue             || '',
          taxDue:             v.taxDue             || '',
          tyreSizeOptions:    v.tyreSizeOptions    || [],
        },
        tyreSize: {
          tyreSizeFront:   tyreSizes.tyreSizeFront   || '',
          speedRatingFront:tyreSizes.speedRatingFront|| '',
          loadIndexFront:  tyreSizes.loadIndexFront  || '',
          tyrePressureFront:tyreSizes.tyrePressureFront|| '',
          tyreSizeRear:    tyreSizes.tyreSizeRear    || '',
          speedRatingRear: tyreSizes.speedRatingRear || '',
          loadIndexRear:   tyreSizes.loadIndexRear   || '',
          tyrePressureRear:tyreSizes.tyrePressureRear|| '',
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

  // 3. Create sale
  try {
    const items = (args.service_ids as number[]).map((sid) => ({
      saleLineID: 0,
      productID:  0,
      serviceID:  sid,
      itemCode:   '',
      quantity:   1,
      unitCost:   0,
      unitPrice:  0,
      discount:   0,
    }));

    const saleResp = await axios.post(`${base}/createSale`, {
      depotID:     cfg.depotId,
      customerID,
      vehicleID,
      saleDate:    args.slot_date,
      saleStatus:  'Order',
      notes:       'Booked via ReceptionMate chat agent',
      poNumber:    '',
      flag:        '',
      flagNotes:   '',
      channelID:   24, // ReceptionMate API channel
      orderStatus: 'Awaiting Acknowledgement',
      bookingSlot: {
        date:            args.slot_date,
        time:            args.slot_time,
        diaryCategoryID: args.diary_category_id,
        estimatedTime:   args.estimated_time,
        slotTypeID:      args.slot_type_id,
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
  if (config.branchAddress) prompt += `📍 ${config.branchAddress}\n`;
  if (config.phoneNumber)   prompt += `📞 ${config.phoneNumber}\n`;
  if (config.emailAddress)  prompt += `📧 ${config.emailAddress}\n`;
  if (config.websiteUrl)    prompt += `🌐 ${config.websiteUrl}\n`;
  prompt += `\n`;

  if (config.weeklyOpeningHours) {
    prompt += `Opening hours:\n`;
    const hours = config.weeklyOpeningHours as Record<string, any>;
    for (const [day, times] of Object.entries(hours)) {
      if (times && typeof times === 'object' && 'open' in times && 'close' in times) {
        const d = day.charAt(0).toUpperCase() + day.slice(1);
        prompt += `${d}: ${times.open} – ${times.close}\n`;
      }
    }
    prompt += `\nWe're currently ${isOpen ? '✅ OPEN' : '🔒 CLOSED'}.\n\n`;
  }

  if (knowledgeDocs.length) {
    prompt += `Additional info:\n`;
    for (const doc of knowledgeDocs) {
      if (doc.title) prompt += `${doc.title}:\n`;
      prompt += `${doc.content}\n\n`;
    }
  }

  if (hasCreds) {
    prompt += `\n🎯 BOOKING FLOW:\n\n`;

    prompt += `**Step 1 – Understand the request**\n`;
    prompt += `- Ask what they need and get their vehicle reg.\n`;
    prompt += `- Call ts_get_services to know what's available.\n`;
    prompt += `- Match their request intelligently (e.g. "oil change" → Full Service).\n`;
    prompt += `- If they want tyres, tell them you'll arrange a callback to provide a quote.\n\n`;

    prompt += `**Step 2 – Confirm the vehicle**\n`;
    prompt += `- Call ts_lookup_vehicle with their reg number.\n`;
    prompt += `- Confirm: "I've got you down as a [Year] [Make] [Model] — is that right?"\n\n`;

    prompt += `**Step 3 – Get timeslots**\n`;
    prompt += `- Call ts_get_timeslots with the service_ids for their chosen service.\n`;
    prompt += `- Offer 3–4 upcoming options in natural language.\n\n`;

    prompt += `**Step 4 – Confirm & collect contact details**\n`;
    prompt += `- Collect: full name, phone number (and optionally email, postcode).\n`;
    prompt += `- Read back all details: "So that's a [service] on [date] at [time] for [name] — shall I confirm that?"\n`;
    prompt += `- Only call ts_create_booking after the customer says YES.\n\n`;

    prompt += `⚠️ RULES:\n`;
    prompt += `- Never call ts_create_booking without explicit customer confirmation.\n`;
    prompt += `- Never re-run ts_lookup_vehicle if already done in this session.\n`;
    prompt += `- Keep replies concise — 1 to 3 sentences.\n\n`;

    if (session.vrm) {
      prompt += `🔥 ACTIVE SESSION:\n`;
      prompt += `- Vehicle: ${session.vrm}`;
      if (session.vehicle?.make) prompt += ` (${session.vehicle.make} ${session.vehicle.model})`;
      prompt += `\n`;
      if (session.serviceIds?.length) {
        prompt += `- Service IDs selected: ${session.serviceIds.join(', ')}\n`;
      }
      prompt += `- Do NOT call ts_lookup_vehicle again — already complete.\n\n`;
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
