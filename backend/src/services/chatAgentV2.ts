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
  CONFIRMING_POSTCODE = 'confirming_postcode',
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
  contactPostcode: string;
  contactStreet: string;
  contactCity: string;
  contactHouseNumber: string;
  postcodeConfirmed: boolean;
  notes: string;
  
  // Message
  message: string;
  preferredCallbackTime: string;

  // Diagnostics
  diagnosticNotes: string;      // accumulated symptom notes to put in booking notes
  diagnosticComplete: boolean;  // true once diagnostic Q&A is done
  diagnosticQuestions: string[]; // questions asked — used to detect if answers are still coming in
}

const inMemorySessionCache = new Map<string, ChatSession>();

// Session storage - persist to database
async function getOrCreateSession(conversationId: string): Promise<ChatSession> {
  const cached = inMemorySessionCache.get(conversationId);
  if (cached) {
    return { ...cached };
  }

  console.log(`[GET_SESSION] Loading session for conversation ${conversationId}`);
  
  // Try to load from database using raw SQL (sessionState column may not be in Prisma types)
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ sessionState: any }>>(
      `SELECT "sessionState" FROM "ChatConversation" WHERE id = $1`,
      conversationId
    );
    
    if (rows.length > 0 && rows[0].sessionState) {
      const sessionData = rows[0].sessionState as any;
      console.log(`[GET_SESSION] Found existing session, step: ${sessionData.step}`);
      const loadedSession: ChatSession = {
        step: sessionData.step || Step.GREETING,
        intent: sessionData.intent || '',
        customerNameFirst: sessionData.customerNameFirst || '',
        customerNameLast: sessionData.customerNameLast || '',
        vrn: sessionData.vrn || '',
        vrnConfirmed: sessionData.vrnConfirmed || false,
        sessionId: sessionData.sessionId || '',
        vehicleMake: sessionData.vehicleMake || '',
        vehicleModel: sessionData.vehicleModel || '',
        servicesAvailable: sessionData.servicesAvailable || [],
        serviceSelectedId: sessionData.serviceSelectedId || '',
        serviceSelectedName: sessionData.serviceSelectedName || '',
        servicePrice: sessionData.servicePrice || '',
        timeslotsAvailable: sessionData.timeslotsAvailable || [],
        bookingDate: sessionData.bookingDate || '',
        bookingTime: sessionData.bookingTime || '',
        contactPhone: sessionData.contactPhone || '',
        contactEmail: sessionData.contactEmail || '',
        contactPostcode: sessionData.contactPostcode || '',
        contactStreet: sessionData.contactStreet || '',
        contactCity: sessionData.contactCity || '',
        contactHouseNumber: sessionData.contactHouseNumber || '',
        postcodeConfirmed: sessionData.postcodeConfirmed || false,
        notes: sessionData.notes || '',
        message: sessionData.message || '',
        preferredCallbackTime: sessionData.preferredCallbackTime || '',
        diagnosticNotes: sessionData.diagnosticNotes || '',
        diagnosticComplete: sessionData.diagnosticComplete || false,
        diagnosticQuestions: sessionData.diagnosticQuestions || [],
      };
      inMemorySessionCache.set(conversationId, loadedSession);
      // Auto-advance: if timeslot was already chosen but server restarted before step updated
      if (loadedSession.step === Step.NEED_TIMESLOT && loadedSession.bookingDate && loadedSession.bookingTime) {
        loadedSession.step = Step.NEED_CONTACT;
        console.log(`[GET_SESSION] Auto-advanced step to need_contact (timeslot already set)`);
      }
      return loadedSession;
    }
  } catch (error) {
    console.error(`[GET_SESSION] DB load failed:`, error);
  }

  console.log(`[GET_SESSION] No existing session found, creating new one`);
  
  // Create new session
  const newSession: ChatSession = {
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
    contactPostcode: '',
    contactStreet: '',
    contactCity: '',
    contactHouseNumber: '',
    postcodeConfirmed: false,
    notes: '',
    message: '',
    preferredCallbackTime: '',
    diagnosticNotes: '',
    diagnosticComplete: false,
    diagnosticQuestions: [],
  };

  inMemorySessionCache.set(conversationId, newSession);
  return newSession;
}

async function saveSession(conversationId: string, session: ChatSession): Promise<void> {
  inMemorySessionCache.set(conversationId, { ...session });
  console.log(`[SAVE_SESSION] Saving session for ${conversationId}, step: ${session.step}, phone: ${session.contactPhone}`);
  
  try {
    // Strip large timeslot array before saving to DB (keep only first 5 for recovery)
    const sessionToSave = {
      ...session,
      timeslotsAvailable: (session.timeslotsAvailable || []).slice(0, 5),
    };
    // Use raw SQL to update sessionState (Prisma client may not have the column in its types)
    const sessionJson = JSON.stringify(sessionToSave);
    console.log(`[SAVE_SESSION] JSON size: ${sessionJson.length} bytes, timeslots: ${sessionToSave.timeslotsAvailable.length}`);
    await prisma.$executeRawUnsafe(
      `UPDATE "ChatConversation" SET "sessionState" = $1::jsonb WHERE id = $2`,
      sessionJson,
      conversationId
    );
    console.log(`[SAVE_SESSION] ✅ Successfully saved session for ${conversationId}`);
  } catch (error) {
    console.error(`[SAVE_SESSION] ❌ Failed to save session for ${conversationId}:`, error);
    // Don't throw - in-memory cache is the fallback
  }
}

export async function getChatAgentResponse(
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
    const session = await getOrCreateSession(conversationId);

    // Seed contact details passed explicitly from the widget pre-chat form
    let seedApplied = false;
    if (seedContact?.phone && !session.contactPhone) {
      session.contactPhone = seedContact.phone.replace(/\s+/g, '');
      console.log(`[SEED_CONTACT] Phone seeded: ${session.contactPhone}`);
      seedApplied = true;
    }
    if (seedContact?.name && !session.customerNameFirst) {
      const parts = seedContact.name.trim().split(/\s+/);
      session.customerNameFirst = parts[0] || '';
      session.customerNameLast = parts.slice(1).join(' ') || '';
      console.log(`[SEED_CONTACT] Name seeded: ${session.customerNameFirst} ${session.customerNameLast}`);
      seedApplied = true;
    }

    // Build conversation context
    const previousMessages = await prisma.chatMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
      take: 10,
    });

    hydrateSessionFromMessageHistory(session, previousMessages as Array<{ role: string; content: string }>);

    // Re-apply seed after hydration to ensure it wins over any contradictory history
    if (seedContact?.phone && !session.contactPhone) {
      session.contactPhone = seedContact.phone.replace(/\s+/g, '');
      seedApplied = true;
    }

    // Also scan the CURRENT message for contact details (e.g. user puts phone in their first message)
    if (!session.contactPhone) {
      const phoneInMsg = message.match(/(?:\+44\s?7\d{3}|\b07\d{3})\s?\d{3}\s?\d{3,4}\b/i);
      if (phoneInMsg) {
        session.contactPhone = phoneInMsg[0].replace(/\s+/g, '');
        console.log(`[SEED_CONTACT] Phone found in message: ${session.contactPhone}`);
        seedApplied = true;
      }
    }

    // Persist seeded data immediately so a backend restart won't lose it
    if (seedApplied) {
      await saveSession(conversationId, session);
    }

    // Fast-path: timeslot selection — handle locally with matchTimeslot(), no OpenAI call needed
    // (mirrors the Python voice agent's specialist_timeslot_match approach)
    if (session.step === Step.NEED_TIMESLOT && session.timeslotsAvailable && session.timeslotsAvailable.length > 0) {
      const matched = matchTimeslot(message, session.timeslotsAvailable);
      if (matched) {
        const instructions = await handleSelectTimeslot({ preference: message }, session, conversationId);
        return {
          content: instructionToCustomerReply(instructions),
          needsHumanAssistance: false,
        };
      } else {
        // No match — offer a few options without hitting OpenAI
        const firstSlots = session.timeslotsAvailable.slice(0, 3).map((t: any) =>
          `${formatDateNaturally(t.date)} at ${formatTimeNaturally(t.time)}`
        ).join(', or ');
        return {
          content: `I didn't quite catch that — I have ${firstSlots}. Which works for you?`,
          needsHumanAssistance: false,
        };
      }
    }

    // Fast-path: once a timeslot is booked, handle all contact collection locally (no OpenAI)
    const bookingComplete = !!(session.bookingDate && session.bookingTime);
    if (session.step === Step.NEED_CONTACT || bookingComplete) {
      // Ensure step is correct
      if (bookingComplete && session.step !== Step.CONFIRMED && session.step !== Step.DONE) {
        session.step = Step.NEED_CONTACT;
      }
      const contactArgs = extractContactArgsFromMessage(message, session);
      const instructions = await handleSetContactInfo(contactArgs, session, conversationId);
      return {
        content: instructionToCustomerReply(instructions),
        needsHumanAssistance: false,
      };
    }

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

    // Retry wrapper for OpenAI 429 rate limit errors
    async function openAIWithRetry(msgs: OpenAI.Chat.ChatCompletionMessageParam[], temp: number): Promise<OpenAI.Chat.ChatCompletion> {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return await getOpenAI().chat.completions.create({
            model: 'gpt-4o',
            messages: msgs,
            temperature: temp,
            max_tokens: 300,
            tools: getConversationalTools(),
            tool_choice: 'auto',
          });
        } catch (err: any) {
          if (err?.status === 429 && attempt < 2) {
            const retryMs = parseInt(err?.headers?.['retry-after-ms'] || '1000', 10);
            const waitMs = Math.min(retryMs + 200, 5000);
            console.log(`[OPENAI_RETRY] 429 rate limit, waiting ${waitMs}ms (attempt ${attempt + 1})`);
            await new Promise(r => setTimeout(r, waitMs));
            continue;
          }
          throw err;
        }
      }
      throw new Error('OpenAI retries exhausted');
    }

    let response = await openAIWithRetry(messages, temperature);

    // Handle function calls (tools return instructions)
    let iterations = 0;
    const maxIterations = 5;

    while (response.choices[0]?.finish_reason === 'tool_calls' && iterations < maxIterations) {
      iterations++;
      const toolCalls = response.choices[0].message.tool_calls;

      if (!toolCalls) break;

      messages.push(response.choices[0].message);

      let needContactFastPath = false;

      for (const toolCall of toolCalls) {
        if (toolCall.type !== 'function') continue;

        const functionName = toolCall.function.name;
        const functionArgs = JSON.parse(toolCall.function.arguments);

        console.log(`[CHAT_AGENT_V2] Calling: ${functionName}`, functionArgs);

        // If we're already in NEED_CONTACT (set by a prior tool in this batch),
        // skip any remaining tool calls - hand off to the fast-path instead
        if ((session.step as Step) === Step.NEED_CONTACT) {
          console.log(`[CHAT_AGENT_V2] Skipping ${functionName} - already in NEED_CONTACT, using fast-path`);
          needContactFastPath = true;
          // Still need to push a placeholder tool result so OpenAI message history is valid
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: 'Skipped - contact collection in progress',
          });
          continue;
        }

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

        // Check immediately after each tool call
        if ((session.step as Step) === Step.NEED_CONTACT) {
          needContactFastPath = true;
        }
      }

      // Hand off to fast-path if any tool transitioned us into NEED_CONTACT
      if (needContactFastPath) {
        const contactArgs = extractContactArgsFromMessage(message, session);
        const instructions = await handleSetContactInfo(contactArgs, session, conversationId);
        return {
          content: instructionToCustomerReply(instructions),
          needsHumanAssistance: false,
        };
      }

      // Get next response with instructions integrated
      response = await openAIWithRetry(messages, temperature);
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

function extractContactArgsFromMessage(message: string, session: ChatSession): any {
  const args: any = {};
  const text = message.trim();

  const emailMatch = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if (!session.contactEmail && emailMatch) {
    args.email = emailMatch[0].toLowerCase();
  }

  const phoneMatch = text.match(/(?:\+44\s?7\d{3}|\b07\d{3})\s?\d{3}\s?\d{3,4}\b/i);
  if (!session.contactPhone && phoneMatch) {
    args.phone = phoneMatch[0].replace(/\s+/g, '');
  }

  const postcodeMatch = text.match(/\b([A-Z]{1,2}\d{1,2}[A-Z]?\s*\d[A-Z]{2})\b/i);
  if (!session.contactPostcode && postcodeMatch) {
    args.postcode = postcodeMatch[1].toUpperCase();
  }

  // Treat as house number/name once we have postcode (no confirmation step needed)
  const isYes = /^(yes|yeah|yep|yup|correct|sure|ok|okay)$/i.test(text.trim());
  const isNo = /^(no|nope|wrong|incorrect)$/i.test(text.trim());
  const isLikelyHouseNumber = /^[A-Za-z0-9\-\s,\.]{1,40}$/.test(text) &&
    !emailMatch && !phoneMatch && !postcodeMatch &&
    !isYes && !isNo &&
    !/^(thanks|cheers)$/i.test(text.trim());

  // Only capture as house number once we already have postcode saved
  if (!session.contactHouseNumber && session.contactPostcode && isLikelyHouseNumber) {
    args.houseNumber = text;
  }

  return args;
}

function hydrateSessionFromMessageHistory(session: ChatSession, messages: Array<{ role: string; content: string }>): void {
  if (!messages || messages.length === 0) {
    return;
  }

  for (const msg of messages) {
    if (msg.role !== 'user' || !msg.content) {
      continue;
    }

    const extracted = extractContactArgsFromMessage(msg.content, session);

    if (!session.contactPhone && extracted.phone) {
      session.contactPhone = extracted.phone;
    }
    if (!session.contactEmail && extracted.email) {
      session.contactEmail = extracted.email;
    }
    if (!session.contactPostcode && extracted.postcode) {
      session.contactPostcode = extracted.postcode;
    }
    if (!session.contactHouseNumber && extracted.houseNumber) {
      session.contactHouseNumber = extracted.houseNumber;
    }
  }

  // If we recovered any contact data and step is behind need_contact, advance it
  if ((session.contactPhone || session.contactEmail || session.contactPostcode) &&
      session.step !== Step.NEED_CONTACT && session.step !== Step.CONFIRMED && session.step !== Step.DONE) {
    if (session.bookingDate && session.bookingTime) {
      session.step = Step.NEED_CONTACT;
    }
  }
}

function instructionToCustomerReply(instructions: string): string {
  const sayMatch = instructions.match(/Say:\s*"([\s\S]*?)"/i);
  if (sayMatch && sayMatch[1]) {
    return sayMatch[1].trim();
  }

  if (instructions.startsWith('Need phone')) {
    return 'Can I get your phone number?';
  }
  if (instructions.startsWith('Need email')) {
    return 'And your email address?';
  }
  if (instructions.startsWith('Need postcode')) {
    return "What's your postcode?";
  }
  if (instructions.startsWith('Postcode')) {
    return "And what's your house number or name?";
  }

  return 'Thanks — could you repeat that contact detail for me?';
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
        description: 'Save contact info and confirm booking. Collects phone, email, postcode (auto-looks up location), then house number.',
        parameters: {
          type: 'object',
          properties: {
            phone: { type: 'string', description: 'Customer phone number' },
            email: { type: 'string', description: 'Customer email address' },
            postcode: { type: 'string', description: 'UK postcode for address lookup' },
            houseNumber: { type: 'string', description: 'House number or name' },
          },
          required: [],
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
    if (
      session.step === Step.NEED_CONTACT &&
      (toolName === 'save_caller_name' || toolName === 'select_service' || toolName === 'select_timeslot')
    ) {
      console.log(`[STATE_GUARD] Blocking ${toolName} while in NEED_CONTACT`);
      return getNextContactInstruction(session);
    }

    switch (toolName) {
      case 'save_caller_name':
        return await handleSaveCallerName(args, session, conversationId);
      
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

function getNextContactInstruction(session: ChatSession): string {
  if (!session.contactPhone) {
    return `Need phone.\n\nSay: "Can I get your phone number?"\nWait for phone, then call set_contact_info.`;
  }

  if (!session.contactEmail) {
    return `Need email.\n\nSay: "And your email address?"\nWait for email, then call set_contact_info.`;
  }

  if (!session.contactPostcode) {
    return `Need postcode.\n\nSay: "What's your postcode?"\nWait for postcode, then call set_contact_info.`;
  }

  if (!session.contactHouseNumber) {
    if (session.contactStreet && session.contactCity) {
      return `Postcode found: ${session.contactStreet}, ${session.contactCity}.\n\nSay: "Is that ${session.contactStreet}, ${session.contactCity}?"\nOnce confirmed, ask: "And your house number or name?"\nWait for house number, then call set_contact_info.`;
    }
    if (session.contactCity) {
      return `Postcode found: ${session.contactCity}.\n\nSay: "Is that the ${session.contactCity} area?"\nOnce confirmed, ask: "And your house number or name?"\nWait for house number, then call set_contact_info.`;
    }
    return `Postcode accepted.\n\nSay: "And your house number or name?"\nWait for house number, then call set_contact_info.`;
  }

  return `All contact info is already collected.\nSay: "Thanks, I’ve got everything I need to confirm this now."\nCall set_contact_info with ZERO SPEECH to finalize.`;
}

// Tool handlers (return instructions like voice agent)

async function handleSaveCallerName(args: any, session: ChatSession, conversationId: string): Promise<string> {
  const { first_name, last_name = '', intent, service_hint = '' } = args;

  if (session.step === Step.NEED_CONTACT) {
    console.log('[STATE_GUARD] Ignoring save_caller_name during NEED_CONTACT');
    return getNextContactInstruction(session);
  }
  
  session.customerNameFirst = first_name;
  session.customerNameLast = last_name;
  session.intent = intent;
  
  console.log(`[SAVE_NAME] ${first_name} ${last_name}, intent: ${intent}`);
  console.log(`[SAVE_NAME] About to save session...`);
  
  if (intent === 'message') {
    session.step = Step.MESSAGE_ONLY;
    await saveSession(conversationId, session);
    console.log(`[SAVE_NAME] Session saved for message intent`);
    return `Customer wants to leave a message.\nSay: "Sure thing ${first_name}, what can I help you with?"\nWait for their message, then call take_message.`;
  }
  
  // Booking or quote flow
  session.step = Step.NEED_VRN;
  await saveSession(conversationId, session);
  console.log(`[SAVE_NAME] Session saved for booking intent`);
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
  await saveSession(conversationId, session);
  
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
    await saveSession(conversationId, session);
    
    console.log(`[LOOKUP_VEHICLE] Found: ${make} ${model}, session: ${sessionId}`);
    
    const makeTitle = make.toLowerCase().split(' ').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const modelTitle = model.toLowerCase().split(' ').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    
    return `Vehicle found: ${makeTitle} ${modelTitle} (${winningReg}).\nNOW call confirm_vehicle(confirmed=true) immediately — ZERO SPEECH. Do not wait for customer input.`;
    
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
    await saveSession(conversationId, session);
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
  // Reset diagnostics so fresh questions fire for this vehicle's booking
  session.diagnosticComplete = false;
  session.diagnosticNotes = '';
  session.diagnosticQuestions = [];
  await saveSession(conversationId, session);
  
  console.log('[CONFIRM_VEHICLE] Confirmed, fetching services...');
  
  // Fetch available services
  try {
    const services = await ghListServices(session.sessionId);
    session.servicesAvailable = services;
    
    console.log(`[CONFIRM_VEHICLE] Fetched ${services.length} services`);
    console.log(`[CONFIRM_VEHICLE] Services: ${services.map((s: any) => `${s.name}(${s.service_price_id})`).join(', ')}`);
    
    if (services.length === 0) {
      return `Vehicle confirmed but no services available.\nSay: "Let me grab your details and we'll give you a call back with a quote."\nThen call take_message.`;
    }
    
    const serviceList = services.slice(0, 5).map((s: any, i: number) => {
      const p = s.price || 0;
      let priceStr = '';
      if (!s.hide_service_prices && p > 0) {
        if (s.estimate) priceStr = ` — from around £${p}`;
        else if (s.from_price) priceStr = ` — from £${p}`;
        else priceStr = ` — £${p}`;
      }
      return `${i + 1}. ${s.name}${priceStr}`;
    }).join('\n');
    
    return `Vehicle confirmed: ${session.vehicleMake} ${session.vehicleModel}.\n${services.length} services available.\n\nTop services:\n${serviceList}\n\nSay: "Perfect! I've got your ${session.vehicleMake} ${session.vehicleModel}. What work does it need?"\nWait for their answer, then call select_service with the service name they mention.`;
    
  } catch (error: any) {
    console.error('[CONFIRM_VEHICLE] Failed to fetch services:', error);
    return `Vehicle confirmed but failed to load services.\nSay: "Let me grab your details and we'll call you back with a quote." Then call take_message.`;
  }
}

async function handleSelectService(args: any, session: ChatSession, conversationId: string): Promise<string> {
  const { service_name } = args;

  if (session.step === Step.NEED_CONTACT) {
    console.log('[STATE_GUARD] Ignoring select_service during NEED_CONTACT');
    return getNextContactInstruction(session);
  }

  console.log(`[SELECT_SERVICE] Looking for: ${service_name}`);

  if (!session.servicesAvailable || session.servicesAvailable.length === 0) {
    return `No services loaded yet. Call confirm_vehicle first.`;
  }

  // ── Run diagnostic questions if this looks like a symptom description ──
  if (!session.diagnosticComplete) {
    const diagQuestions = await specialistDiagnosticQuestions(service_name);
    if (diagQuestions && diagQuestions.length > 0) {
      // Store the symptom and questions in session
      session.diagnosticNotes = service_name;
      session.diagnosticQuestions = diagQuestions;
      session.diagnosticComplete = true; // prevents re-running diagnostic check
      await saveSession(conversationId, session);
      console.log(`[DIAGNOSTIC_Q] Asking ${diagQuestions.length} questions for: ${service_name}`);
      // Return instruction that tells LLM to chat naturally — NO tool calls until all answers collected
      const qList = diagQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n');
      return `DIAGNOSTIC MODE — symptom: "${service_name}"\n\nAsk these questions ONE BY ONE in natural conversation (do NOT call any tool yet):\n${qList}\n\nIMPORTANT: Do NOT call select_service until you have asked ALL questions and received ALL answers. Once you have all the answers, call select_service with a full symptom summary like: "knocking noise from front, constant, gets worse when braking, started 2 weeks ago".`;
    }
    // Not a symptom — mark complete so we don't re-check
    session.diagnosticComplete = true;
  }

  // ── If diagnosticComplete is set but service_name looks like a diagnostic answer (short, no service match likely), accumulate it ──
  // This catches cases where LLM incorrectly calls select_service with answer text like "constant" or "yes it is"
  if (session.diagnosticQuestions && session.diagnosticQuestions.length > 0) {
    const isLikelyAnswer = service_name.split(' ').length <= 4 && !session.servicesAvailable.some(
      (s: any) => s.name.toLowerCase().includes(service_name.toLowerCase().slice(0, 5))
    );
    if (isLikelyAnswer) {
      // Accumulate answer into diagnostic notes
      session.diagnosticNotes = (session.diagnosticNotes ? session.diagnosticNotes + ', ' : '') + service_name;
      // Remove first unanswered question
      session.diagnosticQuestions = session.diagnosticQuestions.slice(1);
      await saveSession(conversationId, session);
      console.log(`[DIAGNOSTIC_Q] Answer accumulated: "${service_name}", ${session.diagnosticQuestions.length} questions remaining`);
      if (session.diagnosticQuestions.length > 0) {
        return `Answer noted. Now ask: "${session.diagnosticQuestions[0]}" — do NOT call any tool yet. Continue asking the remaining questions. Once all answered, call select_service with a full symptom summary.`;
      } else {
        // All answered — clear questions array and proceed to service selection below with the accumulated notes
        console.log(`[DIAGNOSTIC_Q] All answered, proceeding to service match with notes: ${session.diagnosticNotes}`);
        session.diagnosticQuestions = [];
        // Fall through to service matching below using diagnosticNotes as the effective service_name
      }
    }
  }

  // ── Use diagnostic notes as the effective service description if available ──
  // (when all diagnostic Q&A has been collected and LLM calls select_service with a summary)
  const effectiveServiceName = session.diagnosticNotes && session.diagnosticQuestions.length === 0
    ? session.diagnosticNotes
    : service_name;

  // ── Specialist GPT-4o-mini service match (mirrors Python specialist_service_match) ──
  let matched = matchService(effectiveServiceName, session.servicesAvailable);
  let matchReason = '';

  if (!matched) {
    const specialistResult = await specialistServiceMatch(effectiveServiceName, session.servicesAvailable);
    if (specialistResult) {
      matched = specialistResult.service;
      matchReason = specialistResult.reason;
      console.log(`[SERVICE_ADVISOR] Specialist matched: ${matched.name} — ${matchReason}`);
    }
  }

  // ── If still no match, silently book under "Other" (Python behaviour) ──
  if (!matched) {
    matched = session.servicesAvailable.find((s: any) => /other|general/i.test(s.name)) || null;
    if (matched) {
      console.log(`[SELECT_SERVICE] No match for '${effectiveServiceName}' — booking under '${matched.name}'`);
    } else {
      // Truly nothing — take a message
      return `No suitable service found for "${effectiveServiceName}" and no Other/General fallback.\nSay: "I don't have that as a set price right now. Let me take your details and one of the team will give you a call back with a quote."\nThen call take_message.`;
    }
  }

  const serviceId = matched.service_price_id;
  const serviceName = matched.name;
  const price = matched.price;

  // Append diagnostic notes to booking notes if collected
  if (session.diagnosticNotes) {
    session.notes = (session.notes ? session.notes + ' | ' : '') + `Symptom: ${session.diagnosticNotes}`;
  }
  
  console.log(`[SELECT_SERVICE] Matched: ${serviceName} (${serviceId}), £${price}`);
  
  try {
    // Set service via API
    await ghSetService(session.sessionId, String(serviceId));
    
    session.serviceSelectedId = String(serviceId);
    session.serviceSelectedName = serviceName;
    session.servicePrice = price;
    session.step = Step.NEED_TIMESLOT;
    
    // Fetch timeslots BEFORE saving so the cache has them
    const timeslots = await ghListTimeslots(session.sessionId);
    session.timeslotsAvailable = timeslots;
    await saveSession(conversationId, session);
    
    console.log(`[SELECT_SERVICE] Fetched ${timeslots.length} timeslots`);
    
    if (timeslots.length === 0) {
      // No timeslots — collect contact details then record as a callback request
      session.notes = (session.notes ? session.notes + ' | ' : '') + `Callback requested for: ${serviceName}`;
      session.step = Step.NEED_CONTACT;
      await saveSession(conversationId, session);
      return `Service noted: ${serviceName}. No online timeslots — switching to callback flow.\nSay: "I don't have any online availability right now — let me take your details and the team will be in touch to get you booked in."\nNow collect contact details using set_contact_info (phone, email, postcode, house number).`;
    }
    
    const firstSlots = timeslots.slice(0, 3).map((t: any) => {
      const dateNatural = formatDateNaturally(t.date);
      const timeNatural = formatTimeNaturally(t.time);
      return `${dateNatural} at ${timeNatural}`;
    }).join(', or ');
    
    const makeTitle = session.vehicleMake.toLowerCase().split(' ').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const modelTitle = session.vehicleModel.toLowerCase().split(' ').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const priceNum = parseFloat(String(price));
    const priceDisplay = (!price || isNaN(priceNum) || priceNum < 1) ? 'POA' : `£${priceNum.toFixed(2).replace(/\.00$/, '')}`;

    // Quote flow vs booking flow
    if (session.intent === 'quote') {
      return `Service set: ${serviceName} (${priceDisplay}).\n${timeslots.length} timeslots available.\n\nFirst available: ${firstSlots}\n\nSay: "A ${serviceName} for your ${makeTitle} ${modelTitle} is ${priceDisplay}. Would you like me to book that in for you?"\nIf YES → say "The earliest I have is ${firstSlots} — does one of those work for you?" and wait for their preference, then call select_timeslot.\nIf NO → say "No problem! If you'd like to book it in later, just give us a call." then call take_message.`;
    }

    return `Service set: ${serviceName} (${priceDisplay}).\n${timeslots.length} timeslots available.\n\nFirst available: ${firstSlots}\n\nSay: "A ${serviceName} for your ${makeTitle} ${modelTitle} is ${priceDisplay}. The earliest I have is ${firstSlots} — does one of those work for you?"\nWait for their preference, then call select_timeslot.`;
    
  } catch (error: any) {
    console.error('[SELECT_SERVICE] API error:', error);
    return `Failed to set service.\nSay: "Let me take your details and the team will book that in for you." Then call take_message.`;
  }
}

async function handleSelectTimeslot(args: any, session: ChatSession, conversationId: string): Promise<string> {
  const { preference } = args;

  if (session.step === Step.NEED_CONTACT && session.bookingDate && session.bookingTime) {
    console.log('[STATE_GUARD] Ignoring select_timeslot during NEED_CONTACT');
    return getNextContactInstruction(session);
  }
  
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
    console.log(`[SELECT_TIMESLOT] ghSetTimeslot succeeded, saving step=need_contact to DB`);
    await saveSession(conversationId, session);
    
    console.log('[SELECT_TIMESLOT] Timeslot set, need contact info');
    
    const dateNatural = formatDateNaturally(date);
    const timeNatural = formatTimeNaturally(time);
    
    const nextContactAsk = session.contactPhone
      ? (session.contactEmail ? `What's your postcode?` : `Can I grab your email address?`)
      : `Can I just grab a contact number?`;
    return `Timeslot set: ${dateNatural} at ${timeNatural}.\n\nSay: "Perfect, I've got you booked for ${dateNatural} at ${timeNatural}. ${nextContactAsk}"\nWait for their response.`;
    
  } catch (error: any) {
    console.error('[SELECT_TIMESLOT] API error:', error);
    return `Failed to set timeslot.\nSay: "Let me take your number and the team will confirm that time." Then call take_message.`;
  }
}

async function handleSetContactInfo(args: any, session: ChatSession, conversationId: string): Promise<string> {
  const { phone = '', email = '', postcode = '', houseNumber = '' } = args;
  
  console.log(`[SET_CONTACT] Args - Phone: ${phone}, Email: ${email}, Postcode: ${postcode}, House: ${houseNumber}`);
  console.log(`[SET_CONTACT] Session step: ${session.step}, Phone: ${session.contactPhone}, Email: ${session.contactEmail}, Postcode: ${session.contactPostcode}, House: ${session.contactHouseNumber}`);
  
  // Force correct step — if booking is already set, we're always in contact collection
  if (session.bookingDate && session.bookingTime && session.step !== Step.CONFIRMED && session.step !== Step.DONE) {
    session.step = Step.NEED_CONTACT;
  }
  
  // Save any new information provided
  if (phone && !session.contactPhone) {
    session.contactPhone = phone;
    console.log(`[SET_CONTACT] Saved phone: ${phone}`);
  }
  if (email && !session.contactEmail) {
    session.contactEmail = email;
    console.log(`[SET_CONTACT] Saved email: ${email}`);
  }
  if (postcode && !session.contactPostcode) {
    // Validate and lookup postcode
    const cleanPostcode = postcode.replace(/\s+/g, '').toUpperCase();
    try {
      const geoResponse = await axios.get(`https://api.postcodes.io/postcodes/${cleanPostcode}`);
      if (geoResponse.data && geoResponse.data.result) {
        const result = geoResponse.data.result;
        session.contactPostcode = postcode;
        session.contactStreet = result.parish || result.admin_ward || '';
        session.contactCity = result.admin_district || result.postcode_area || '';
        console.log(`[SET_CONTACT] Postcode lookup: ${session.contactStreet}, ${session.contactCity}`);
      } else {
        session.contactPostcode = postcode;
        console.log(`[SET_CONTACT] Postcode accepted but no geo data`);
      }
    } catch (error) {
      session.contactPostcode = postcode;
      console.log(`[SET_CONTACT] Postcode lookup failed, using anyway`);
    }
  }
  if (houseNumber && !session.contactHouseNumber) {
    session.contactHouseNumber = houseNumber;
    console.log(`[SET_CONTACT] Saved house number: ${houseNumber}`);
  }
  
  // Save session after collecting any new info
  await saveSession(conversationId, session);
  
  // Check what we still need and ask for it
  if (!session.contactPhone) {
    console.log(`[SET_CONTACT] Need: phone`);
    return `Need phone.\n\nSay: "Can I get your phone number?"\nWait for phone.`;
  }
  
  if (!session.contactEmail) {
    console.log(`[SET_CONTACT] Need: email`);
    return `Need email.\n\nSay: "And your email address?"\nWait for email.`;
  }
  
  if (!session.contactPostcode) {
    console.log(`[SET_CONTACT] Need: postcode`);
    return `Need postcode.\n\nSay: "What's your postcode?"\nWait for postcode.`;
  }
  
  // After postcode saved, ask for house number directly and confirm the area
  if (!session.contactHouseNumber) {
    console.log(`[SET_CONTACT] Need: house number`);
    session.step = Step.NEED_CONTACT;
    await saveSession(conversationId, session);
    const area = session.contactCity || session.contactStreet || '';
    const areaConfirm = area ? `Is that ${area}? ` : '';
    return `Postcode saved (${session.contactPostcode}, ${area || 'looked up'}).\n\nSay: "${areaConfirm}And what's your house number or name?"\nWait for house number.`;
  }
  
  console.log(`[SET_CONTACT] All info collected, submitting to GH API`);
  
  try {
    // Submit booking with all required GH fields
    const contactAddress = `${session.contactHouseNumber}, ${session.contactStreet}`.replace(/^,\s*/, '').replace(/,\s*$/, '');
    const result = await ghSetContactInfo(session.sessionId, {
      contact_name: session.customerNameFirst,
      contact_last_name: session.customerNameLast,
      contact_email: session.contactEmail,
      contact_number: session.contactPhone,
      contact_address: contactAddress,
      contact_city: session.contactCity,
      contact_postcode: session.contactPostcode,
      contact_salutation: 10,
      contact_address2: '',
      notes: session.notes || '',
    });
    
    if (result.status === 'error') {
      console.error('[SET_CONTACT] Booking failed:', result);
      return `Failed to confirm booking: ${result.message || 'Unknown error'}.\nSay: "Having a bit of trouble with the booking system. The team will give you a call to confirm everything. Thanks ${session.customerNameFirst}! 👍"\nDone.`;
    }
    
    session.step = Step.CONFIRMED;
    await saveSession(conversationId, session);
    
    console.log('[SET_CONTACT] Booking confirmed!');
    
    const dateNatural = formatDateNaturally(session.bookingDate);
    const timeNatural = formatTimeNaturally(session.bookingTime);
    const makeTitle = session.vehicleMake.toLowerCase().split(' ').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const modelTitle = session.vehicleModel.toLowerCase().split(' ').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    
    const confirmedPriceNum = parseFloat(String(session.servicePrice));
    const confirmedPriceDisplay = (!session.servicePrice || isNaN(confirmedPriceNum) || confirmedPriceNum < 1) ? 'POA' : `£${confirmedPriceNum.toFixed(2).replace(/\.00$/, '')}`;
    const summary = `✅ Booking confirmed!\n- Customer: ${session.customerNameFirst} ${session.customerNameLast}\n- Vehicle: ${makeTitle} ${modelTitle} (${session.vrn})\n- Service: ${session.serviceSelectedName} (${confirmedPriceDisplay})\n- Date/Time: ${dateNatural} at ${timeNatural}\n- Phone: ${session.contactPhone}\n- Email: ${session.contactEmail}`;
    
    return `${summary}\n\nSay: "All done! You're booked in for ${dateNatural} at ${timeNatural} for a ${session.serviceSelectedName}${confirmedPriceDisplay !== 'POA' ? ` (${confirmedPriceDisplay})` : ''}. We'll send you a confirmation email. See you then! 👍"\n\nBooking complete - conversation can end naturally.`;
    
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
  await saveSession(conversationId, session);
  
  // Store message in database (TODO: create Messages table or use notes)
  // For now, just log it
  
  const serviceContext = session.serviceSelectedName ? ` about ${session.serviceSelectedName}` : '';
  return `Message recorded.\n- Phone: ${phone}\n- Message: ${message}\n- Callback time: ${callback_time || 'not specified'}\n\nSay: "Perfect ${session.customerNameFirst}, I've passed that on${serviceContext}. The team will give you a call${callback_time ? ` ${callback_time}` : ' soon'} — have a great day!"\n\nConversation complete.`;
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
  
  console.log(`[GH_SET_CONTACT] HTTP ${response.status} response:`, JSON.stringify(response.data));

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

// ── Specialist: GPT-4o-mini service advisor (mirrors Python specialist_service_match) ──
async function specialistServiceMatch(callerText: string, services: any[]): Promise<{ service: any; reason: string } | null> {
  if (!services.length || !callerText) return null;
  const svcList = services.map((s: any) => {
    const p = s.price || 0;
    let priceStr = '';
    if (!s.hide_service_prices && p > 0) {
      if (s.estimate) priceStr = ` (from around £${p})`;
      else if (s.from_price) priceStr = ` (from £${p})`;
      else priceStr = ` (£${p})`;
    }
    return `- ${s.name}${priceStr}`;
  }).join('\n');
  const systemPrompt = `You are an automotive service advisor at a UK garage.
Given the customer's description and the available services, pick the single most suitable service.

Rules:
- "hasn't been serviced / long time / overdue" → Full Service
- Noises, rattles, warning lights, unknown issues → Diagnostic Check
- Specific systems (brakes, oil, tyres, air con, cam belt) → match to the relevant service
- MOT / test → MOT
- Tyres, puncture, wheel → look for a tyre or wheel service; if none exists, return {"service_name":"Other","reason":"no tyre service listed"}
- If genuinely unclear, return null

Reply with JSON ONLY — no extra text:
{"service_name": "exact name from the list", "reason": "one short sentence"}`;
  const userMsg = `Customer said: "${callerText}"\n\nAvailable services:\n${svcList}`;
  try {
    const resp = await getOpenAI().chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.1,
      max_tokens: 120,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMsg },
      ],
    });
    let raw = (resp.choices[0]?.message?.content || '').trim();
    if (raw.startsWith('```')) raw = raw.split('\n').slice(1).join('\n').replace(/```$/, '').trim();
    const data = JSON.parse(raw);
    const svcName: string = data.service_name || '';
    const reason: string = data.reason || '';
    if (!svcName || svcName === 'null') return null;
    // Exact match
    for (const svc of services) {
      if (svc.name.toLowerCase() === svcName.toLowerCase()) return { service: svc, reason };
    }
    // Fuzzy match
    const sl = svcName.toLowerCase();
    for (const svc of services) {
      const n = svc.name.toLowerCase();
      if (sl.includes(n) || n.includes(sl)) return { service: svc, reason };
    }
    // If specialist said "Other", find an Other/General service
    if (sl === 'other' || sl === 'general') {
      const other = services.find((s: any) => /other|general/i.test(s.name));
      if (other) return { service: other, reason };
    }
    return null;
  } catch (e) {
    console.warn('[SERVICE_ADVISOR] Error:', e);
    return null;
  }
}

// ── Specialist: GPT-4o-mini diagnostic questions (mirrors Python specialist_diagnostic_questions) ──
const SYMPTOM_KEYWORDS = [
  'noise','sound','knock','rattle','squeal','grind','click','clunk',
  'vibrat','shak','judder','pull','warning','light','dashboard','check engine',
  'abs','smell','smoke','leak','overheat','hot','burning','problem','issue',
  'fault','wrong','broken','not working',"won't",'doesn\'t',"can't",'struggling',
  'rough','stuttering','hesitat','cutting out','loss of power','no power','limp',
  'stall','misfire','sluggish','gearbox','clutch','suspension','handling',
];

async function specialistDiagnosticQuestions(symptomText: string): Promise<string[] | null> {
  const lower = symptomText.toLowerCase();
  if (!SYMPTOM_KEYWORDS.some(k => lower.includes(k))) return null;

  const systemPrompt = `You are a diagnostic specialist at a UK garage.
The customer has described a symptom. Generate 2–3 short follow-up questions to help diagnose it.

Symptom types:
- NOISE: ask when it happens, constant/intermittent, changes with speed
- WARNING LIGHT: which light, driving normally, limp mode?
- PERFORMANCE: struggling to start, loss of power, cutting out?
- OVERHEATING/SMELL/SMOKE: any smoke, burning smell, temperature gauge?
- Always ask: when did this first start, has it got worse?

Rules:
- Short conversational UK English questions only
- Max 3 questions
- If the description is already very detailed, return {"questions":[]}

Reply with JSON ONLY:
{"questions": ["q1", "q2", "q3"], "symptom_type": "noise|warning_light|performance|overheating|vague"}`;

  try {
    const resp = await getOpenAI().chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      max_tokens: 200,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Customer description: "${symptomText}"` },
      ],
    });
    let raw = (resp.choices[0]?.message?.content || '').trim();
    if (raw.startsWith('```')) raw = raw.split('\n').slice(1).join('\n').replace(/```$/, '').trim();
    const data = JSON.parse(raw);
    const qs: string[] = data.questions || [];
    return qs.length > 0 ? qs : null;
  } catch (e) {
    console.warn('[DIAGNOSTIC_Q] Error:', e);
    return null;
  }
}

function matchService(query: string, services: any[]): any | null {
  const queryLower = query.toLowerCase().trim();

  // Exact match
  for (const service of services) {
    if (service.name.toLowerCase() === queryLower) return service;
  }

  // Service name contains query or query contains service name (only if query >= 3 chars)
  if (queryLower.length >= 3) {
    for (const service of services) {
      const sn = service.name.toLowerCase();
      if (sn.includes(queryLower) || queryLower.includes(sn)) return service;
    }
  }

  // Keyword match — but require that matching keywords are meaningful (length >= 4)
  // AND score must be above a threshold relative to service name length
  const keywords = queryLower.split(/\s+/).filter(k => k.length >= 4);
  if (keywords.length > 0) {
    let bestService: any = null;
    let bestScore = 0;
    for (const service of services) {
      const sn = service.name.toLowerCase();
      const snWords = sn.split(/\s+/);
      const matchCount = keywords.filter(k => sn.includes(k)).length;
      // Score = fraction of service name words that matched
      const score = matchCount / Math.max(snWords.length, keywords.length);
      if (score > bestScore) {
        bestScore = score;
        bestService = service;
      }
    }
    // Only return if at least 50% of words matched — prevents 'tyres' matching 'Full Service'
    if (bestScore >= 0.5) return bestService;
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

  // Extract a specific time mention like "1:30pm", "9am", "14:00"
  function extractPrefHour(text: string): number | null {
    const m = text.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
    if (!m) return null;
    let h = parseInt(m[1]);
    const meridiem = (m[3] || '').toLowerCase();
    if (meridiem === 'pm' && h < 12) h += 12;
    if (meridiem === 'am' && h === 12) h = 0;
    return h;
  }

  function closestByTime(candidates: any[], prefHour: number | null): any {
    if (!prefHour || candidates.length === 1) return candidates[0];
    return candidates.reduce((best, t) => {
      const tH = parseInt(t.time.split(':')[0]);
      const bH = parseInt(best.time.split(':')[0]);
      return Math.abs(tH - prefHour) <= Math.abs(bH - prefHour) ? t : best;
    });
  }

  // "First", "earliest", "ASAP"
  if (prefLower.includes('first') || prefLower.includes('earliest') || prefLower.includes('asap')) {
    return timeslots[0];
  }

  // Named day — "Monday", "Tuesday", etc.
  const dayNames = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  for (const dayName of dayNames) {
    if (prefLower.includes(dayName)) {
      const matches = timeslots.filter(t => {
        const d = new Date(t.date);
        return d.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase() === dayName;
      });
      if (matches.length > 0) return closestByTime(matches, extractPrefHour(prefLower));
    }
  }

  // "Tomorrow"
  if (prefLower.includes('tomorrow')) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];
    const matches = timeslots.filter(t => t.date === tomorrowStr);
    if (matches.length > 0) return closestByTime(matches, extractPrefHour(prefLower));
  }

  // "Today"
  if (prefLower.includes('today')) {
    const todayStr = new Date().toISOString().split('T')[0];
    const matches = timeslots.filter(t => t.date === todayStr);
    if (matches.length > 0) return closestByTime(matches, extractPrefHour(prefLower));
  }

  // "Next week" — skip to slots 7+ days away
  if (prefLower.includes('next week')) {
    const nextWeek = new Date();
    nextWeek.setDate(nextWeek.getDate() + 7);
    const nwStr = nextWeek.toISOString().split('T')[0];
    const matches = timeslots.filter(t => t.date >= nwStr);
    if (matches.length > 0) return closestByTime(matches, extractPrefHour(prefLower));
  }

  // "Morning" (before 12:00)
  if (prefLower.includes('morning')) {
    const matches = timeslots.filter(t => parseInt(t.time.split(':')[0]) < 12);
    if (matches.length > 0) return matches[0];
  }

  // "Afternoon" (12:00–17:00)
  if (prefLower.includes('afternoon')) {
    const matches = timeslots.filter(t => {
      const h = parseInt(t.time.split(':')[0]);
      return h >= 12 && h < 17;
    });
    if (matches.length > 0) return matches[0];
  }

  // Specific time only (e.g. "1:30pm", "9am") — find closest across all slots
  const prefHour = extractPrefHour(prefLower);
  if (prefHour !== null) {
    return closestByTime(timeslots, prefHour);
  }

  // Default to first available
  return timeslots[0];
}

function buildSystemPromptV2(config: any, knowledgeDocuments: any[], _isOpen: boolean, session: ChatSession): string {
  const branchName = config.branchName || 'our garage';

  // ── Persona ──────────────────────────────────────────────────────────────
  let prompt = `You are Leah, the AI receptionist at ${branchName}. You are available 24/7 to take bookings and answer questions.\n`;
  if (config.greetingLine) prompt += `${config.greetingLine}\n`;
  prompt += '\n';

  // ── Opening hours info (for when customer asks, not to gate bookings) ────
  let openingHoursSummary = '';
  if (config.weeklyOpeningHours) {
    const hours = config.weeklyOpeningHours as Record<string, any>;
    const lines: string[] = [];
    for (const [day, times] of Object.entries(hours)) {
      const t = times as any;
      if (t && typeof t === 'object' && t.open && t.close) {
        lines.push(`${day.charAt(0).toUpperCase() + day.slice(1)}: ${t.open}–${t.close}`);
      }
    }
    openingHoursSummary = lines.join(', ');
  }

  // ── Contact details — always include so location/phone questions always work ──
  if (config.branchAddress) prompt += `Address: ${config.branchAddress}\n`;
  if (config.phoneNumber) prompt += `Phone: ${config.phoneNumber}\n`;
  if (openingHoursSummary) prompt += `Opening hours: ${openingHoursSummary}\n`;
  prompt += '\n';

  // ── Knowledge base — only before vehicle is looked up to keep token count low ──
  if (!session.sessionId && knowledgeDocuments.length > 0) {
    for (const doc of knowledgeDocuments) {
      if (doc.title) prompt += `${doc.title}:\n`;
      prompt += `${doc.content}\n\n`;
    }
  }

  // ── Key behaviour rules around opening hours ─────────────────────────────
  prompt += `OPENING HOURS BEHAVIOUR:
- You can take bookings at ANY time of day — you are always available.
- Only mention opening hours if the customer specifically asks about them.
- If the customer asks to speak to a human/agent/someone, say: "Unfortunately the team are currently outside of office hours, but I can take a message and they'll be in touch during opening hours${openingHoursSummary ? ` (${openingHoursSummary})` : ''}. What would you like to pass on?" Then call take_message.\n\n`;

  // ── Current booking state ─────────────────────────────────────────────────
  prompt += `CURRENT STATE: ${session.step}\n`;
  if (session.customerNameFirst) prompt += `Customer: ${session.customerNameFirst} ${session.customerNameLast || ''}\n`;
  if (session.vrn) prompt += `Vehicle: ${session.vehicleMake} ${session.vehicleModel} (${session.vrn})\n`;
  if (session.serviceSelectedName) prompt += `Service: ${session.serviceSelectedName}${session.servicePrice ? ` (${session.servicePrice})` : ''}\n`;
  if (session.bookingDate) prompt += `Slot: ${session.bookingDate} at ${session.bookingTime}\n`;

  // ── Available services — inject when loaded so agent can answer price/options questions ──
  if (session.servicesAvailable && session.servicesAvailable.length > 0) {
    const svcLines = session.servicesAvailable.map((s: any) => {
      const p = s.price || 0;
      let priceStr = '';
      if (!s.hide_service_prices && p > 0) {
        if (s.estimate) priceStr = ` — from around £${p}`;
        else if (s.from_price) priceStr = ` — from £${p}`;
        else priceStr = ` — £${p}`;
      }
      return `- ${s.name}${priceStr}`;
    }).join('\n');
    prompt += `\nAVAILABLE SERVICES:\n${svcLines}\n`;
    prompt += `If the customer asks "what are the options", "what services do you offer", or "what are the prices", list these services with their prices naturally. Then ask what they need.\n`;
  }

  prompt += '\n';

  // ── Booking flow instructions ─────────────────────────────────────────────
  prompt += `BOOKING FLOW (follow in order):
1. Get customer name + intent → call save_caller_name
2. Get vehicle registration → call lookup_vehicle
3. IMMEDIATELY call confirm_vehicle(confirmed=true) — do NOT wait for customer input, do NOT ask them to confirm, just call it silently
4. Customer says what work is needed → call select_service
5. Offer timeslots from tool response → handled automatically, no tool call needed from you
6. Contact details collected automatically after timeslot
7. Booking confirmed ✅

RULES:
- Tools return instructions — follow them exactly, especially "Say: ..." and "Wait for ..." phrases
- NEVER answer questions about services/prices from your own knowledge — only use what tools return after confirm_vehicle has been called
- If the customer asks about services or prices before confirm_vehicle is called, call confirm_vehicle(confirmed=true) first silently, then answer using the tool result
- Keep responses short (1–2 sentences)
- Address customer by first name only
- Never invent booking details — only use what tools return
- If you cannot proceed, offer to take a message for a callback\n`;

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
