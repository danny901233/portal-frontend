import { prisma } from '../db.js';
import OpenAI from 'openai';
import axios from 'axios';

// Lazy-load OpenAI client
let openaiClient: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!openaiClient) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is not configured');
    }
    openaiClient = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }
  return openaiClient;
}

// GarageHive configuration - loaded from garage config
let GH_CUSTOMER_ID: string | undefined;
let GH_API_KEY: string | undefined;
let GH_LOCATION_ID: string = '23';

interface ChatAgentResponse {
  content: string;
  needsHumanAssistance?: boolean;
}

// Chat session state (mirrors voice agent's CallState)
enum Step {
  GREETING = 'greeting',
  NEED_NAME = 'need_name',
  NEED_VRN = 'need_vrn',
  CONFIRMING_VEHICLE = 'confirming_vehicle',
  NEED_SERVICE = 'need_service',
  NEED_TIMESLOT = 'need_timeslot',
  NEED_CONTACT = 'need_contact',
  CONFIRMED = 'confirmed',
  DONE = 'done',
  MESSAGE_ONLY = 'message_only',
}

interface ChatSession {
  step: Step;
  intent: string; // 'booking', 'quote', 'message'
  
  // Customer
  customerNameFirst: string;
  customerNameLast: string;
  
  // Vehicle
  vrn: string;
  vrnConfirmed: boolean;
  sessionId: string;
  vehicleMake: string;
  vehicleModel: string;
  
  // Service
  servicesAvailable: any[];
  serviceSelectedId: string;
  serviceSelectedName: string;
  servicePrice: string;
  
  // Timeslot
  timeslotsAvailable: any[];
  bookingDate: string;
  bookingTime: string;
  
  // Contact
  contactPhone: string;
  contactEmail: string;
  notes: string;
  
  // Message
  message: string;
  preferredCallbackTime: string;
}

// Session storage (in-memory for now)
const chatSessions = new Map<string, ChatSession>();

function getOrCreateSession(conversationId: string): ChatSession {
  if (!chatSessions.has(conversationId)) {
    chatSessions.set(conversationId, {
      step: Step.GREETING,
      intent: '',
      customerNameFirst: '',
      customerNameLast: '',
      vrn: '',
      vrnConfirmed: false,
      sessionId: '',
      vehicleMake: '',
      vehicleModel: '',
      servicesAvailable: [],
      serviceSelectedId: '',
      serviceSelectedName: '',
      servicePrice: '',
      timeslotsAvailable: [],
      bookingDate: '',
      bookingTime: '',
      contactPhone: '',
      contactEmail: '',
      notes: '',
      message: '',
      preferredCallbackTime: '',
    });
  }
  return chatSessions.get(conversationId)!;
}

export async function getChatAgentResponse(
  garageId: string,
  message: string,
  conversationId: string
): Promise<ChatAgentResponse> {
  try {
    const garage = await prisma.garage.findUnique({
      where: { id: garageId },
      include: {
        agentConfiguration: true,
        knowledgeDocuments: {
          orderBy: { updatedAt: 'desc' },
          take: 20,
        },
      },
    });

    if (!garage || !garage.agentConfiguration) {
      throw new Error('Garage configuration not found');
    }

    const config = garage.agentConfiguration;
    const isOpen = checkOpeningHours(config.weeklyOpeningHours);

    // Load GarageHive credentials
    if (config.integrationProviderConfig && typeof config.integrationProviderConfig === 'object') {
      const ghConfig = config.integrationProviderConfig as any;
      GH_CUSTOMER_ID = ghConfig.ghCustomerId || ghConfig.customerId;
      GH_API_KEY = ghConfig.ghApiKey || ghConfig.apiKey;
      GH_LOCATION_ID = ghConfig.ghLocationId || ghConfig.locationId || '23';
    }

    // Get or create session state
    const session = getOrCreateSession(conversationId);

    // Build conversation context
    const previousMessages = await prisma.chatMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
      take: 10,
    });

    // Build system prompt with state awareness
    const systemPrompt = buildSystemPromptV2(config, garage.knowledgeDocuments, isOpen, session);

    // Build messages
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
    ];

    for (const msg of previousMessages) {
      messages.push({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: msg.content,
      });
    }

    messages.push({ role: 'user', content: message });

    // Call OpenAI with function tools (instruction-based)
    const temperature = session.sessionId ? 0.5 : 0.7;

    let response = await getOpenAI().chat.completions.create({
      model: 'gpt-4o',
      messages,
      temperature,
      max_tokens: 300,
      tools: getConversationalTools(),
      tool_choice: 'auto',
    });

    // Handle function calls (tools return instructions)
    let iterations = 0;
    const maxIterations = 5;

    while (response.choices[0]?.finish_reason === 'tool_calls' && iterations < maxIterations) {
      iterations++;
      const toolCalls = response.choices[0].message.tool_calls;

      if (!toolCalls) break;

      messages.push(response.choices[0].message);

      for (const toolCall of toolCalls) {
        if (toolCall.type !== 'function') continue;

        const functionName = toolCall.function.name;
        const functionArgs = JSON.parse(toolCall.function.arguments);

        console.log(`[CHAT_AGENT_V2] Calling: ${functionName}`, functionArgs);

        // Execute tool and get INSTRUCTIONS for the agent
        const instructions = await executeConversationalTool(
          functionName,
          functionArgs,
          session,
          conversationId
        );

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: instructions,
        });
      }

      // Get next response with instructions integrated
      response = await getOpenAI().chat.completions.create({
        model: 'gpt-4o',
        messages,
        temperature,
        max_tokens: 300,
        tools: getConversationalTools(),
        tool_choice: 'auto',
      });
    }

    const finalResponse = response.choices[0]?.message?.content ||
      'I apologize, but I am unable to respond at this time. Please try again later.';

    return {
      content: finalResponse,
      needsHumanAssistance: false,
    };
  } catch (error) {
    console.error('[CHAT_AGENT_V2] Error:', error);
    throw error;
  }
}

// Conversational tools that return INSTRUCTIONS (like voice agent)
function getConversationalTools(): OpenAI.Chat.ChatCompletionTool[] {
  return [
    {
      type: 'function',
      function: {
        name: 'save_caller_name',
        description: 'Save customer name and intent. Call this FIRST when customer introduces themselves or states what they need.',
        parameters: {
          type: 'object',
          properties: {
            first_name: { type: 'string', description: 'Customer first name' },
            last_name: { type: 'string', description: 'Customer last name (optional)' },
            intent: { type: 'string', enum: ['booking', 'quote', 'message'], description: 'What they want: booking, quote, or message' },
            service_hint: { type: 'string', description: 'Service mentioned (e.g., "MOT", "service", "oil change")' },
          },
          required: ['first_name', 'intent'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'lookup_vehicle',
        description: 'Look up vehicle by registration number.',
        parameters: {
          type: 'object',
          properties: {
            registration: { type: 'string', description: 'Vehicle registration (e.g., "AB12CDE" or "AB12 CDE")' },
          },
          required: ['registration'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'confirm_vehicle',
        description: 'Confirm or reject the vehicle lookup. Can also correct customer name if they mention it.',
        parameters: {
          type: 'object',
          properties: {
            confirmed: { type: 'boolean', description: 'True if vehicle is correct, false if wrong' },
            corrected_first_name: { type: 'string', description: 'If caller corrects their first name, provide it here' },
            corrected_last_name: { type: 'string', description: 'If caller corrects their last name, provide it here' },
          },
          required: ['confirmed'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'select_service',
        description: 'Select a service by name (fuzzy matching applied automatically).',
        parameters: {
          type: 'object',
          properties: {
            service_name: { type: 'string', description: 'Service customer wants (e.g., "Full Service", "MOT", "Oil Change")' },
          },
          required: ['service_name'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'select_timeslot',
        description: 'Select a booking timeslot based on customer preference.',
        parameters: {
          type: 'object',
          properties: {
            preference: { type: 'string', description: 'Customer timeslot preference (e.g., "tomorrow morning", "next week", "the first one")' },
          },
          required: ['preference'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'set_contact_info',
        description: 'Save contact info and confirm booking.',
        parameters: {
          type: 'object',
          properties: {
            phone: { type: 'string', description: 'Customer phone number' },
            email: { type: 'string', description: 'Customer email (optional)' },
          },
          required: ['phone'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'take_message',
        description: 'Take a message for callback when booking cannot be completed.',
        parameters: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'Customer message' },
            phone: { type: 'string', description: 'Customer phone number' },
            callback_time: { type: 'string', description: 'Preferred callback time (optional)' },
          },
          required: ['message', 'phone'],
        },
      },
    },
  ];
}

// Execute tools and return INSTRUCTIONS (voice agent pattern)
async function executeConversationalTool(
  toolName: string,
  args: any,
  session: ChatSession,
  conversationId: string
): Promise<string> {
  try {
    switch (toolName) {
      case 'save_caller_name':
        return await handleSaveCallerName(args, session);
      
      case 'lookup_vehicle':
        return await handleLookupVehicle(args, session, conversationId);
      
      case 'confirm_vehicle':
        return await handleConfirmVehicle(args, session, conversationId);
      
      case 'select_service':
        return await handleSelectService(args, session, conversationId);
      
      case 'select_timeslot':
        return await handleSelectTimeslot(args, session, conversationId);
      
      case 'set_contact_info':
        return await handleSetContactInfo(args, session, conversationId);
      
      case 'take_message':
        return await handleTakeMessage(args, session, conversationId);
      
      default:
        return `Unknown tool: ${toolName}`;
    }
  } catch (error: any) {
    console.error(`[TOOL_ERROR] ${toolName}:`, error);
    return `Error in ${toolName}: ${error.message}`;
  }
}

// Tool handlers (return instructions like voice agent)

async function handleSaveCallerName(args: any, session: ChatSession): Promise<string> {
  const { first_name, last_name = '', intent, service_hint = '' } = args;
  
  session.customerNameFirst = first_name;
  session.customerNameLast = last_name;
  session.intent = intent;
  
  console.log(`[SAVE_NAME] ${first_name} ${last_name}, intent: ${intent}`);
  
  if (intent === 'message') {
    session.step = Step.MESSAGE_ONLY;
    return `Customer wants to leave a message.\nSay: "Sure thing ${first_name}, what can I help you with?"\nWait for their message, then call take_message.`;
  }
  
  // Booking or quote flow
  session.step = Step.NEED_VRN;
  return `Name saved: ${first_name} ${last_name}.\nIntent: ${intent}${service_hint ? ` for ${service_hint}` : ''}.\n\nSay: "Nice to meet you ${first_name}! What's your reg?"\nWait for registration, then call lookup_vehicle.`;
}

async function handleLookupVehicle(args: any, session: ChatSession, conversationId: string): Promise<string> {
  const { registration, confirmed = false } = args;
  let normalized = registration.replace(/\s+/g, '').toUpperCase();
  
  console.log(`[LOOKUP_VEHICLE] ${normalized}, confirmed: ${confirmed}`);
  
  if (!GH_CUSTOMER_ID || !GH_API_KEY) {
    return `GarageHive not configured.\nSay: "Let me take your details and the team will call you back."\nThen call take_message.`;
  }
  
  // Chat doesn't need two-step confirmation - just look it up directly
  // Validation first
  if (normalized.length < 4) {
    return `PARTIAL registration: only got '${normalized}' so far.\nSay: "Could you give me the full registration?"\nWait for their complete answer, then call lookup_vehicle again.`;
  }
  
  if (!normalized.match(/\d/)) {
    return `REJECTED: '${normalized}' has no digits — UK registrations always contain numbers.\nSay: "Could I grab your registration?"\nWait for their answer.`;
  }
  
  if (normalized.length > 7) {
    normalized = normalized.slice(0, 7);
  }
  
  session.vrn = normalized;
  
  try {
    // Call GarageHive API with B/V/P retry logic
    const regsToTry = [normalized];
    const firstChar = normalized[0];
    const bvpSwaps: Record<string, string[]> = { 'B': ['V', 'P'], 'V': ['B', 'P'], 'P': ['B', 'V'] };
    
    if (bvpSwaps[firstChar]) {
      for (const alt of bvpSwaps[firstChar]) {
        regsToTry.push(alt + normalized.slice(1));
      }
    }
    
    let result: any = null;
    let winningReg = normalized;
    
    for (const tryReg of regsToTry) {
      try {
        const attemptResult = await ghInitAndSetVehicle(tryReg);
        
        if (!attemptResult.error) {
          const booking = attemptResult.booking || {};
          const vehicle = booking.vehicle || {};
          if (vehicle.make_name || vehicle.model_name) {
            result = attemptResult;
            winningReg = tryReg;
            if (tryReg !== normalized) {
              console.log(`[LOOKUP_VEHICLE] B/V/P auto-fix: ${normalized} → ${tryReg}`);
            }
            break;
          }
        }
      } catch (e) {
        console.log(`[LOOKUP_VEHICLE] Try ${tryReg} failed:`, e);
      }
    }
    
    if (!result || result.error) {
      console.log('[LOOKUP_VEHICLE] Not found after B/V/P retry');
      return `Vehicle not found for registration '${normalized}'.\nSay: "Hmm, I'm not finding that one. Could you double check the registration for me?"\nWait for them to provide it again, then call lookup_vehicle.`;
    }
    
    const booking = result.booking || {};
    const vehicle = booking.vehicle || {};
    const make = vehicle.make_name || '';
    const model = vehicle.model_name || '';
    const sessionId = result.session_id || booking.session_id || '';
    
    if (!make || !model) {
      return `Registration '${normalized}' returned but no vehicle details.\nSay: "Having a bit of trouble looking that up. Mind trying the registration again?"\nThen call lookup_vehicle.`;
    }
    
    session.vrn = winningReg;
    session.sessionId = sessionId;
    session.vehicleMake = make;
    session.vehicleModel = model;
    session.step = Step.CONFIRMING_VEHICLE;
    
    console.log(`[LOOKUP_VEHICLE] Found: ${make} ${model}, session: ${sessionId}`);
    
    const makeTitle = make.toLowerCase().split(' ').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const modelTitle = model.toLowerCase().split(' ').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    
    return `Vehicle found: ${makeTitle} ${modelTitle} (${winningReg}).\n\nSay: "Perfect! I've got your ${makeTitle} ${modelTitle}. What work does it need?"\nThen call confirm_vehicle(confirmed=true) with ZERO SPEECH.`;
    
  } catch (error: any) {
    console.error('[LOOKUP_VEHICLE] API error:', error);
    return `API error looking up vehicle.\nSay: "Our system's being a bit slow. Let me take your details and we'll call you back."\nThen call take_message.`;
  }
}

async function handleConfirmVehicle(args: any, session: ChatSession, conversationId: string): Promise<string> {
  const { confirmed, corrected_first_name = '', corrected_last_name = '' } = args;
  
  if (!confirmed) {
    session.step = Step.NEED_VRN;
    session.vrn = '';
    session.sessionId = '';
    return `Customer said vehicle is wrong.\nSay: "No problem! What's the correct registration?"\nThen call lookup_vehicle with the correct registration.`;
  }
  
  // Apply name corrections if provided
  if (corrected_first_name) {
    session.customerNameFirst = corrected_first_name.trim();
    console.log(`[CONFIRM_VEHICLE] Name corrected: first="${corrected_first_name}"`);
  }
  if (corrected_last_name) {
    session.customerNameLast = corrected_last_name.trim();
    console.log(`[CONFIRM_VEHICLE] Name corrected: last="${corrected_last_name}"`);
  }
  
  session.vrnConfirmed = true;
  session.step = Step.NEED_SERVICE;
  
  console.log('[CONFIRM_VEHICLE] Confirmed, fetching services...');
  
  // Fetch available services
  try {
    const services = await ghListServices(session.sessionId);
    session.servicesAvailable = services;
    
    console.log(`[CONFIRM_VEHICLE] Fetched ${services.length} services`);
    
    if (services.length === 0) {
      return `Vehicle confirmed but no services available.\nSay: "Let me grab your details and we'll give you a call back with a quote."\nThen call take_message.`;
    }
    
    const serviceList = services.slice(0, 5).map((s: any, i: number) => 
      `${i + 1}. ${s.name} - £${s.price}`
    ).join('\n');
    
    return `Vehicle confirmed: ${session.vehicleMake} ${session.vehicleModel}.\n${services.length} services available.\n\nTop services:\n${serviceList}\n\nDon't list all services - just ask naturally: "So what work needs doing?"\nWait for their answer, then call select_service with the service name they mention.`;
    
  } catch (error: any) {
    console.error('[CONFIRM_VEHICLE] Failed to fetch services:', error);
    return `Vehicle confirmed but failed to load services.\nSay: "Let me grab your details and we'll call you back with a quote." Then call take_message.`;
  }
}

async function handleSelectService(args: any, session: ChatSession, conversationId: string): Promise<string> {
  const { service_name } = args;
  
  console.log(`[SELECT_SERVICE] Looking for: ${service_name}`);
  
  if (!session.servicesAvailable || session.servicesAvailable.length === 0) {
    return `No services loaded yet. Call confirm_vehicle first.`;
  }
  
  // Fuzzy match service
  const matched = matchService(service_name, session.servicesAvailable);
  
  if (!matched) {
    const serviceList = session.servicesAvailable.slice(0, 5).map((s: any, i: number) => 
      `${i + 1}. ${s.name} - £${s.price}`
    ).join('\n');
    
    return `No match found for "${service_name}".\nAvailable services:\n${serviceList}\n\nSay: "Hmm, closest I've got is [pick the most relevant one]. That sound right?"\nOr ask what they're looking for if unclear.`;
  }
  
  const serviceId = matched.service_price_id;
  const serviceName = matched.name;
  const price = matched.price;
  
  console.log(`[SELECT_SERVICE] Matched: ${serviceName} (${serviceId}), £${price}`);
  
  try {
    // Set service via API
    await ghSetService(session.sessionId, String(serviceId));
    
    session.serviceSelectedId = String(serviceId);
    session.serviceSelectedName = serviceName;
    session.servicePrice = price;
    session.step = Step.NEED_TIMESLOT;
    
    // Fetch timeslots
    const timeslots = await ghListTimeslots(session.sessionId);
    session.timeslotsAvailable = timeslots;
    
    console.log(`[SELECT_SERVICE] Fetched ${timeslots.length} timeslots`);
    
    if (timeslots.length === 0) {
      return `Service set: ${serviceName} (£${price}).\nNo timeslots available.\nSay: "We're quite busy at the moment. Let me take your number and the team will call you with availability." Then call take_message.`;
    }
    
    const firstSlots = timeslots.slice(0, 3).map((t: any) => {
      const dateNatural = formatDateNaturally(t.date);
      const timeNatural = formatTimeNaturally(t.time);
      return `${dateNatural} at ${timeNatural}`;
    }).join(', or ');
    
    const makeTitle = session.vehicleMake.toLowerCase().split(' ').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const modelTitle = session.vehicleModel.toLowerCase().split(' ').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    
    return `Service set: ${serviceName} (£${price}).\n${timeslots.length} timeslots available.\n\nFirst available: ${firstSlots}\n\nSay: "A ${serviceName} for your ${makeTitle} ${modelTitle} is £${price}. When suits you? The earliest I have is ${firstSlots}."\nWait for their preference, then call select_timeslot.`;
    
  } catch (error: any) {
    console.error('[SELECT_SERVICE] API error:', error);
    return `Failed to set service.\nSay: "Let me take your details and the team will book that in for you." Then call take_message.`;
  }
}

async function handleSelectTimeslot(args: any, session: ChatSession, conversationId: string): Promise<string> {
  const { preference } = args;
  
  console.log(`[SELECT_TIMESLOT] Preference: ${preference}`);
  
  if (!session.timeslotsAvailable || session.timeslotsAvailable.length === 0) {
    return `No timeslots loaded. Call select_service first.`;
  }
  
  // Simple matching (in voice agent, there's a specialist LLM for this)
  const matched = matchTimeslot(preference, session.timeslotsAvailable);
  
  if (!matched) {
    const firstSlots = session.timeslotsAvailable.slice(0, 3).map((t: any) => 
      `${t.date} at ${t.time}`
    ).join(', ');
    
    return `Couldn't match "${preference}" to available slots.\nFirst available: ${firstSlots}\n\nSay: "Let me offer what I have. How about ${firstSlots}?"\nWait for their choice, then call select_timeslot again.`;
  }
  
  const { date, time } = matched;
  
  console.log(`[SELECT_TIMESLOT] Matched: ${date} at ${time}`);
  
  try {
    // Set timeslot via API
    await ghSetTimeslot(session.sessionId, date, time);
    
    session.bookingDate = date;
    session.bookingTime = time;
    session.step = Step.NEED_CONTACT;
    
    console.log('[SELECT_TIMESLOT] Timeslot set, need contact info');
    
    const dateNatural = formatDateNaturally(date);
    const timeNatural = formatTimeNaturally(time);
    
    return `Timeslot set: ${dateNatural} at ${timeNatural}.\n\nSay: "Perfect, I've got you booked for ${dateNatural} at ${timeNatural}. Can I just grab a contact number?"\nWait for their phone, then call set_contact_info.`;
    
  } catch (error: any) {
    console.error('[SELECT_TIMESLOT] API error:', error);
    return `Failed to set timeslot.\nSay: "Let me take your number and the team will confirm that time." Then call take_message.`;
  }
}

async function handleSetContactInfo(args: any, session: ChatSession, conversationId: string): Promise<string> {
  const { phone, email = '' } = args;
  
  console.log(`[SET_CONTACT] Phone: ${phone}, Email: ${email}`);
  
  session.contactPhone = phone;
  session.contactEmail = email;
  
  try {
    // Submit booking via API
    const result = await ghSetContactInfo(session.sessionId, {
      phone,
      email,
      firstName: session.customerNameFirst,
      lastName: session.customerNameLast,
    });
    
    if (result.status === 'error') {
      console.error('[SET_CONTACT] Booking failed:', result);
      return `Failed to confirm booking: ${result.message || 'Unknown error'}.\nSay: "I'm having trouble with our booking system. Let me take your details and the team will call you to confirm." Then call take_message.`;
    }
    
    session.step = Step.CONFIRMED;
    
    console.log('[SET_CONTACT] Booking confirmed!');
    
    const dateNatural = formatDateNaturally(session.bookingDate);
    const timeNatural = formatTimeNaturally(session.bookingTime);
    const makeTitle = session.vehicleMake.toLowerCase().split(' ').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const modelTitle = session.vehicleModel.toLowerCase().split(' ').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    
    const summary = `✅ Booking confirmed!\n- Customer: ${session.customerNameFirst} ${session.customerNameLast}\n- Vehicle: ${makeTitle} ${modelTitle} (${session.vrn})\n- Service: ${session.serviceSelectedName} (£${session.servicePrice})\n- Date/Time: ${dateNatural} at ${timeNatural}\n- Phone: ${session.contactPhone}`;
    
    return `${summary}\n\nSay: "All done! You're booked in for ${dateNatural} at ${timeNatural} for a ${session.serviceSelectedName}. We'll send you a confirmation. See you then! 👍"\n\nBooking complete - conversation can end naturally.`;
    
  } catch (error: any) {
    console.error('[SET_CONTACT] API error:', error);
    return `API error confirming booking.\nSay: "All sorted! The team will give you a call to confirm everything. Thanks ${session.customerNameFirst}! 👍"\nDone.`;
  }
}

async function handleTakeMessage(args: any, session: ChatSession, conversationId: string): Promise<string> {
  const { message, phone, callback_time = '' } = args;
  
  console.log(`[TAKE_MESSAGE] Phone: ${phone}, Message: ${message.substring(0, 50)}...`);
  
  session.message = message;
  session.contactPhone = phone;
  session.preferredCallbackTime = callback_time;
  session.step = Step.MESSAGE_ONLY;
  
  // Store message in database (TODO: create Messages table or use notes)
  // For now, just log it
  
  return `Message recorded.\n- Phone: ${phone}\n- Message: ${message}\n- Callback time: ${callback_time || 'not specified'}\n\nSay: "Perfect ${session.customerNameFirst}, I've got that. The team will give you a call${callback_time ? ` ${callback_time}` : ' soon'}. Have a great day!"\n\nConversation complete.`;
}

// GarageHive API helpers

async function ghInitAndSetVehicle(registration: string): Promise<any> {
  if (!GH_CUSTOMER_ID || !GH_API_KEY) {
    throw new Error('GarageHive not configured');
  }
  
  const baseUrl = `https://onlinebooking.garagehive.co.uk/api/external-booking/${GH_CUSTOMER_ID}`;
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${GH_API_KEY}`,
  };
  
  try {
    // Step 1: Init
    const initResponse = await axios.post(`${baseUrl}/init`, {}, { headers });
    const booking = initResponse.data.booking || {};
    const sessionId = booking.session_id || initResponse.data.sessionId;
    
    if (!sessionId) {
      return { error: 'No session_id in init response' };
    }
    
    // Step 2: Set vehicle
    const vehicleResponse = await axios.post(
      `${baseUrl}/${sessionId}/set-vehicle-info`,
      {
        registration_no: registration,
        reg_no_country: 'GB',
        location_id: parseInt(GH_LOCATION_ID),
      },
      { headers }
    );
    
    return {
      ...vehicleResponse.data,
      session_id: sessionId,
    };
    
  } catch (error: any) {
    console.error('[GH_INIT_VEHICLE] Error:', error.response?.data || error.message);
    return { error: error.response?.data || error.message };
  }
}

async function ghListServices(sessionId: string): Promise<any[]> {
  const baseUrl = `https://onlinebooking.garagehive.co.uk/api/external-booking/${GH_CUSTOMER_ID}`;
  const headers = {
    'Authorization': `Bearer ${GH_API_KEY}`,
  };
  
  const response = await axios.get(`${baseUrl}/${sessionId}/list-services`, { headers });
  return response.data.services || [];
}

async function ghSetService(sessionId: string, servicePriceId: string): Promise<any> {
  const baseUrl = `https://onlinebooking.garagehive.co.uk/api/external-booking/${GH_CUSTOMER_ID}`;
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${GH_API_KEY}`,
  };
  
  const response = await axios.post(
    `${baseUrl}/${sessionId}/set-services`,
    { servicePriceIDs: [parseInt(servicePriceId)] },
    { headers }
  );
  
  return response.data;
}

async function ghListTimeslots(sessionId: string): Promise<any[]> {
  const baseUrl = `https://onlinebooking.garagehive.co.uk/api/external-booking/${GH_CUSTOMER_ID}`;
  const headers = {
    'Authorization': `Bearer ${GH_API_KEY}`,
  };
  
  const response = await axios.get(`${baseUrl}/${sessionId}/list-timeslots`, { headers });
  const timeslots = response.data.timeslots || {};
  
  const result: any[] = [];
  for (const [date, times] of Object.entries(timeslots)) {
    if (Array.isArray(times)) {
      for (const time of times) {
        result.push({ date, time });
      }
    }
  }
  
  return result;
}

async function ghSetTimeslot(sessionId: string, date: string, time: string): Promise<any> {
  const baseUrl = `https://onlinebooking.garagehive.co.uk/api/external-booking/${GH_CUSTOMER_ID}`;
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${GH_API_KEY}`,
  };
  
  const response = await axios.post(
    `${baseUrl}/${sessionId}/set-timeslot`,
    { bookingDate: date, bookingTime: time },
    { headers }
  );
  
  return response.data;
}

async function ghSetContactInfo(sessionId: string, contactInfo: any): Promise<any> {
  const baseUrl = `https://onlinebooking.garagehive.co.uk/api/external-booking/${GH_CUSTOMER_ID}`;
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${GH_API_KEY}`,
  };
  
  const response = await axios.post(
    `${baseUrl}/${sessionId}/set-contact-info`,
    contactInfo,
    { headers }
  );
  
  if (response.status >= 200 && response.status < 300) {
    return { status: 'success', booking: response.data };
  }
  
  return {
    status: 'error',
    message: response.data.message || 'Failed to confirm booking',
    errors: response.data.errors || [],
  };
}

// Utility functions

function matchService(query: string, services: any[]): any | null {
  const queryLower = query.toLowerCase();
  
  // Exact match first
  for (const service of services) {
    if (service.name.toLowerCase() === queryLower) {
      return service;
    }
  }
  
  // Contains match
  for (const service of services) {
    if (service.name.toLowerCase().includes(queryLower) || queryLower.includes(service.name.toLowerCase())) {
      return service;
    }
  }
  
  // Keyword match
  const keywords = queryLower.split(/\s+/);
  for (const service of services) {
    const serviceLower = service.name.toLowerCase();
    if (keywords.some(keyword => serviceLower.includes(keyword))) {
      return service;
    }
  }
  
  return null;
}

function formatDateNaturally(dateStr: string): string {
  const date = new Date(dateStr);
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  
  const dateOnly = dateStr.split('T')[0];
  const todayStr = today.toISOString().split('T')[0];
  const tomorrowStr = tomorrow.toISOString().split('T')[0];
  
  if (dateOnly === todayStr) return 'today';
  if (dateOnly === tomorrowStr) return 'tomorrow';
  
  const dayName = date.toLocaleDateString('en-GB', { weekday: 'long' });
  const day = date.getDate();
  const month = date.toLocaleDateString('en-GB', { month: 'long' });
  
  const suffix = day === 1 || day === 21 || day === 31 ? 'st' : 
                 day === 2 || day === 22 ? 'nd' : 
                 day === 3 || day === 23 ? 'rd' : 'th';
  
  return `${dayName} ${day}${suffix} ${month}`;
}

function formatTimeNaturally(timeStr: string): string {
  const [hours, minutes] = timeStr.split(':');
  const hour = parseInt(hours);
  const min = minutes === '00' ? '' : `:${minutes}`;
  
  if (hour < 12) {
    return hour === 0 ? `12${min}am` : `${hour}${min}am`;
  } else if (hour === 12) {
    return `12${min}pm`;
  } else {
    return `${hour - 12}${min}pm`;
  }
}

function matchTimeslot(preference: string, timeslots: any[]): any | null {
  if (!timeslots || timeslots.length === 0) return null;
  
  const prefLower = preference.toLowerCase();
  
  // "First", "earliest", "ASAP"
  if (prefLower.includes('first') || prefLower.includes('earliest') || prefLower.includes('asap')) {
    return timeslots[0];
  }
  
  // "Tomorrow"
  if (prefLower.includes('tomorrow')) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];
    
    const match = timeslots.find(t => t.date === tomorrowStr);
    if (match) return match;
  }
  
  // "Morning" (before 12:00)
  if (prefLower.includes('morning')) {
    const match = timeslots.find(t => {
      const hour = parseInt(t.time.split(':')[0]);
      return hour < 12;
    });
    if (match) return match;
  }
  
  // "Afternoon" (12:00-17:00)
  if (prefLower.includes('afternoon')) {
    const match = timeslots.find(t => {
      const hour = parseInt(t.time.split(':')[0]);
      return hour >= 12 && hour < 17;
    });
    if (match) return match;
  }
  
  // Default to first available
  return timeslots[0];
}

function buildSystemPromptV2(config: any, knowledgeDocuments: any[], isOpen: boolean, session: ChatSession): string {
  const branchName = config.branchName || 'our garage';
  
  let prompt = `You are Leah, the friendly receptionist at ${branchName}. You're here to help with bookings and answer questions. ${config.greetingLine || ''}\n\n`;
  
  // Business info
  prompt += `About ${branchName}:\n`;
  if (config.branchAddress) prompt += `📍 ${config.branchAddress}\n`;
  if (config.phoneNumber) prompt += `📞 ${config.phoneNumber}\n`;
  if (config.emailAddress) prompt += `📧 ${config.emailAddress}\n`;
  if (config.websiteUrl) prompt += `🌐 ${config.websiteUrl}\n`;
  prompt += `\n`;
  
  // Opening hours
  if (config.weeklyOpeningHours) {
    prompt += `Our hours:\n`;
    const hours = config.weeklyOpeningHours as Record<string, any>;
    for (const [day, times] of Object.entries(hours)) {
      if (times && typeof times === 'object' && 'open' in times && 'close' in times) {
        const dayName = day.charAt(0).toUpperCase() + day.slice(1);
        prompt += `${dayName}: ${times.open} - ${times.close}\n`;
      }
    }
    prompt += `\nWe're currently ${isOpen ? '✅ OPEN' : '🔒 CLOSED'}\n\n`;
  }
  
  // Knowledge base
  if (knowledgeDocuments.length > 0) {
    prompt += `Here's what you should know:\n`;
    for (const doc of knowledgeDocuments) {
      if (doc.title) prompt += `${doc.title}:\n`;
      prompt += `${doc.content}\n\n`;
    }
  }
  
  // State-aware instructions
  prompt += `\n🎯 CURRENT STATE:\n`;
  prompt += `- Step: ${session.step}\n`;
  if (session.customerNameFirst) prompt += `- Customer: ${session.customerNameFirst} ${session.customerNameLast}\n`;
  if (session.intent) prompt += `- Intent: ${session.intent}\n`;
  if (session.vrn) prompt += `- Vehicle: ${session.vehicleMake} ${session.vehicleModel} (${session.vrn})\n`;
  if (session.sessionId) prompt += `- Session ID: ${session.sessionId}\n`;
  if (session.serviceSelectedName) prompt += `- Service: ${session.serviceSelectedName} (£${session.servicePrice})\n`;
  if (session.bookingDate) prompt += `- Timeslot: ${session.bookingDate} at ${session.bookingTime}\n`;
  
  prompt += `\n📋 BOOKING FLOW:\n`;
  prompt += `1. GREETING: Get name and intent → call save_caller_name\n`;
  prompt += `2. Get registration → call lookup_vehicle\n`;
  prompt += `3. Confirm vehicle → call confirm_vehicle\n`;
  prompt += `4. Ask what work needed → call select_service\n`;
  prompt += `5. Offer timeslots → call select_timeslot\n`;
  prompt += `6. Get phone → call set_contact_info\n`;
  prompt += `7. Booking confirmed! ✅\n\n`;
  
  prompt += `⚠️ CRITICAL RULES:\n`;
  prompt += `- Tools return INSTRUCTIONS for you to follow - read them CAREFULLY and follow EXACTLY!\n`;
  prompt += `- When instructions say "GENERATE ZERO SPEECH" or "with ZERO SPEECH" → call the tool WITHOUT saying anything\n`;
  prompt += `- When instructions say "Say: '...'" → say EXACTLY that phrase (or a natural variation)\n`;
  prompt += `- When instructions say "Wait for..." → STOP and wait for customer response, do NOT continue\n`;
  prompt += `- When instructions say "Then call..." → call that tool in your next response\n`;
  prompt += `- Be natural and conversational - you're a real person named Leah, not a robot\n`;
  prompt += `- Keep responses brief (1-2 sentences max) unless customer needs detail\n`;
  prompt += `- NEVER make up booking details - only use information from tool responses\n`;
  prompt += `- If a tool fails 3+ times, offer to take a message for callback\n`;
  prompt += `- Always address customer by their FIRST name only (never surname)\n`;
  prompt += `- Read back registrations letter-by-letter with spaces for clarity\n\n`;
  
  prompt += `Remember: You're a helpful, friendly receptionist. Be yourself! 😊\n`;
  
  return prompt;
}

function checkOpeningHours(weeklyOpeningHours: any): boolean {
  if (!weeklyOpeningHours || typeof weeklyOpeningHours !== 'object') {
    return true;
  }

  const now = new Date();
  const currentDay = now.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
  const currentTime = now.toTimeString().slice(0, 5);

  const todayHours = weeklyOpeningHours[currentDay];

  if (!todayHours || typeof todayHours !== 'object') {
    return false;
  }

  const { open, close } = todayHours;

  if (!open || !close) {
    return false;
  }

  return currentTime >= open && currentTime <= close;
}
