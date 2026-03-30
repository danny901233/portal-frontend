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

// Drop-off booking configuration
let DROP_OFF_ENABLED: boolean = false;
let DROP_OFF_MESSAGE: string = 'drop your vehicle off between 8am and half ten in the morning';
let DROP_OFF_EXCLUDE_SERVICES: string[] = ['MOT'];

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
  NEED_BOOKING_CONFIRM = 'need_booking_confirm',
  NEED_TIMESLOT = 'need_timeslot',
  NEED_SLOT_CONFIRM = 'need_slot_confirm', // waiting for customer to confirm a proposed slot
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
  pendingSlotDate: string;  // proposed slot awaiting customer confirmation
  pendingSlotTime: string;
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

  // Drop-off booking
  useDropOffBooking: boolean;   // true if this service uses drop-off (date only, no specific time)

  // Outbound campaign context (pre-populated when customer replies to a campaign)
  outboundRegistration?: string;
  outboundServiceType?: string;
  outboundDueDate?: string;
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
        pendingSlotDate: sessionData.pendingSlotDate || '',
        pendingSlotTime: sessionData.pendingSlotTime || '',
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
        useDropOffBooking: sessionData.useDropOffBooking || false,
        outboundRegistration: sessionData.outboundRegistration || undefined,
        outboundServiceType: sessionData.outboundServiceType || undefined,
        outboundDueDate: sessionData.outboundDueDate || undefined,
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
    pendingSlotDate: '',
    pendingSlotTime: '',
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
    useDropOffBooking: false,
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
      DROP_OFF_ENABLED = ghConfig.enableDropOffBookings || false;
      DROP_OFF_MESSAGE = ghConfig.dropOffMessage || 'drop your vehicle off between 8am and half ten in the morning';
      DROP_OFF_EXCLUDE_SERVICES = ghConfig.dropOffExcludeServices || ['MOT'];
    }
    if (!GH_CUSTOMER_ID || !GH_API_KEY) {
      console.warn(`[GARAGEHIVE_MISCONFIGURED] garageId=${garageId} is using agentScript=${config.agentScript} but GarageHive credentials are not set in integrationProviderConfig. Vehicle lookups will fall back to take_message.`);
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

    // Fast-path: slot confirmation — customer is saying yes/no to a proposed slot
    if (session.step === Step.NEED_SLOT_CONFIRM && session.pendingSlotDate && session.pendingSlotTime) {
      // Strip emoji, punctuation, and normalise repeated words before testing intent
      const stripped = message.toLowerCase().replace(/[^a-z\s]/g, '').trim().replace(/\b(\w+)\s+\1\b/g, '$1');
      const isYes = /\b(yes|yeah|yep|yup|sure|ok|okay|perfect|great|sounds good|that works|confirm|go ahead|please|fine|brilliant|lovely|brill|ace|spot on|do it|book it|book me in)\b/.test(stripped);
      const isNo = /\b(no|nope|different|another|change|instead|rather|earlier|later|different)\b/.test(stripped);

      // Extract any note from the message even during slot confirmation
      const notePattern = /(?:also|and|btw|by the way|ps|p\.s\.?|additionally|there[''s]*s?|it[''s]*s?|she[''s]*s?)\s+(.{10,})/i;
      const noteMatch = message.match(notePattern);
      if (noteMatch) {
        session.notes = (session.notes ? session.notes + ' | ' : '') + `Customer note: ${noteMatch[1].trim()}`;
      }

      if (isNo) {
        // Customer wants a different slot — go back to timeslot selection
        session.step = Step.NEED_TIMESLOT;
        session.pendingSlotDate = '';
        session.pendingSlotTime = '';
        await saveSession(conversationId, session);
        const firstSlots = session.timeslotsAvailable.slice(0, 3).map((t: any) =>
          `${formatDateNaturally(t.date)} at ${formatTimeNaturally(t.time)}`
        ).join(', or ');
        return {
          content: `No problem — the options I have are ${firstSlots}. Which would you prefer?`,
          needsHumanAssistance: false,
        };
      }

      if (isYes) {
        // Confirm the pending slot — now actually call the API to book it
        try {
          await ghSetTimeslot(session.sessionId, session.pendingSlotDate, session.pendingSlotTime);
          console.log(`[SLOT_CONFIRM] ghSetTimeslot succeeded for ${session.pendingSlotDate} at ${session.pendingSlotTime}`);
        } catch (err) {
          console.error('[SLOT_CONFIRM] ghSetTimeslot failed:', err);
        }
        session.bookingDate = session.pendingSlotDate;
        session.bookingTime = session.pendingSlotTime;
        session.step = Step.NEED_CONTACT;
        session.pendingSlotDate = '';
        session.pendingSlotTime = '';
        await saveSession(conversationId, session);
        const nextAsk = session.contactPhone
          ? (session.contactEmail ? `What's your postcode?` : `Can I grab your email address?`)
          : `Can I just grab a contact number?`;
        return {
          content: `Perfect, you're booked in! ${nextAsk}`,
          needsHumanAssistance: false,
        };
      }

      // Unclear response — ask again
      const dateNatural = formatDateNaturally(session.pendingSlotDate);
      const timeNatural = formatTimeNaturally(session.pendingSlotTime);
      return {
        content: `Just to confirm — shall I book you in for ${dateNatural} at ${timeNatural}?`,
        needsHumanAssistance: false,
      };
    }

    // Fast-path: once a timeslot is booked, handle all contact collection locally (no OpenAI)
    const bookingComplete = !!(session.bookingDate && session.bookingTime);
    if (session.step === Step.NEED_CONTACT || bookingComplete) {
      // Ensure step is correct
      if (bookingComplete && session.step !== Step.CONFIRMED && session.step !== Step.DONE) {
        session.step = Step.NEED_CONTACT;
      }

      // Check if the message looks like a note/question rather than contact info
      // If so, append to session notes and acknowledge, then re-ask for the missing contact field
      const contactArgs = extractContactArgsFromMessage(message, session);
      const hasContactInfo = contactArgs.phone || contactArgs.email || contactArgs.postcode || contactArgs.houseNumber;
      const looksLikeNote = !hasContactInfo && message.trim().length > 10 &&
        !/^(yes|no|yeah|yep|correct|sure|ok|okay|thanks|cheers)$/i.test(message.trim());

      if (looksLikeNote) {
        // Save as a note and continue contact collection
        session.notes = (session.notes ? session.notes + ' | ' : '') + `Customer note: ${message.trim()}`;
        await saveSession(conversationId, session);
        const nextAsk = session.contactPhone
          ? (session.contactEmail ? (session.contactPostcode ? `What's your house number or name?` : `What's your postcode?`) : `Can I grab your email address?`)
          : `Can I just grab a contact number?`;
        return {
          content: `Got it, I'll make sure the team knows. ${nextAsk}`,
          needsHumanAssistance: false,
        };
      }

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
    // Slightly higher temperature gives the personality prompt more room to produce natural, varied responses
    const temperature = session.sessionId ? 0.7 : 0.85;

    // Retry wrapper for OpenAI 429 rate limit errors
    // Falls back from gpt-4.1 → gpt-4o on persistent rate limits (gpt-4o has much higher limits)
    const MODEL_PRIMARY = 'gpt-4.1';
    const MODEL_FALLBACK = 'gpt-4o';
    async function openAIWithRetry(msgs: OpenAI.Chat.ChatCompletionMessageParam[], temp: number): Promise<OpenAI.Chat.ChatCompletion> {
      let model = MODEL_PRIMARY;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          return await getOpenAI().chat.completions.create({
            model,
            messages: msgs,
            temperature: temp,
            max_tokens: 300,
            tools: getConversationalTools(),
            tool_choice: 'auto',
          });
        } catch (err: any) {
          // insufficient_quota = account out of credits — no point retrying
          if (err?.code === 'insufficient_quota' || err?.error?.code === 'insufficient_quota') {
            console.error('[OPENAI] Account out of credits — top up at platform.openai.com');
            throw new Error('INSUFFICIENT_QUOTA');
          }
          if (err?.status === 429) {
            // After 2 attempts on primary, switch to fallback model
            if (attempt === 1 && model === MODEL_PRIMARY) {
              console.log(`[OPENAI_RETRY] Switching to fallback model ${MODEL_FALLBACK}`);
              model = MODEL_FALLBACK;
            }
            const retryAfterMs = parseInt(err?.headers?.['retry-after-ms'] || err?.headers?.['retry-after'] * 1000 || '2000', 10);
            const waitMs = Math.min(retryAfterMs + 500, 8000);
            console.log(`[OPENAI_RETRY] 429 on ${model}, waiting ${waitMs}ms (attempt ${attempt + 1})`);
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
      let needTimeslotFastPath = false;
      let timeslotFastPathContent = '';

      for (const toolCall of toolCalls) {
        if (toolCall.type !== 'function') continue;

        const functionName = toolCall.function.name;
        let functionArgs: any;
        try {
          functionArgs = JSON.parse(toolCall.function.arguments);
        } catch {
          console.error(`[CHAT_AGENT_V2] Failed to parse tool args for ${functionName}:`, toolCall.function.arguments);
          functionArgs = {};
        }

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

        // If service was already set this batch, skip remaining tool calls
        if (needTimeslotFastPath) {
          console.log(`[CHAT_AGENT_V2] Skipping ${functionName} - service already set, using timeslot fast-path`);
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: 'Skipped - service already selected, awaiting timeslot choice',
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

        // If select_service just succeeded and transitioned to NEED_TIMESLOT, short-circuit
        if (functionName === 'select_service' && (session.step as Step) === Step.NEED_TIMESLOT) {
          const sayMatch = instructions.match(/Say:\s*"([\s\S]*?)"/i);
          if (sayMatch) {
            needTimeslotFastPath = true;
            timeslotFastPathContent = sayMatch[1].trim();
            console.log(`[CHAT_AGENT_V2] Service set — using timeslot fast-path`);
          }
        }
      }

      // Hand off to fast-path if any tool transitioned us into NEED_CONTACT
      if (needContactFastPath) {
        // Check if the tool result already contains a Say: instruction we should use directly
        // (e.g. 0-timeslot path sets a specific "no availability" message)
        const lastToolResult = messages.filter(m => m.role === 'tool').pop();
        const toolContent = typeof lastToolResult?.content === 'string' ? lastToolResult.content : '';
        const sayMatch = toolContent.match(/Say:\s*"([\s\S]*?)"/i);
        if (sayMatch) {
          return {
            content: sayMatch[1].trim(),
            needsHumanAssistance: false,
          };
        }
        // Otherwise ask for the next missing contact field
        const nextAsk = !session.contactPhone
          ? `Can I just grab a contact number?`
          : !session.contactEmail
          ? `Can I grab your email address?`
          : !session.contactPostcode
          ? `What's your postcode?`
          : `What's your house number or name?`;
        return {
          content: nextAsk,
          needsHumanAssistance: false,
        };
      }

      // Service was just set — return the timeslot prompt directly without another GPT call
      if (needTimeslotFastPath && timeslotFastPathContent) {
        return {
          content: timeslotFastPathContent,
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

  const phoneMatch = text.match(/\+[\d\s\-]{7,18}|\b0\d[\d\s\-]{8,13}/);
  if (!session.contactPhone && phoneMatch) {
    args.phone = phoneMatch[0].replace(/\s+/g, '');
  }

  // UK postcode: outward (e.g. CV23, B1, SW1A, W1A) + optional space + inward (digit + 2 letters)
  // Crucially the inward section must start with a digit — this prevents VRNs like V20ALA matching
  // Also accepts typos missing the last 1-2 chars (e.g. cv239z, cv239)
  const postcodeMatch = text.match(/\b([A-Z]{1,2}\d[\dA-Z]?\s*\d[A-Z]{0,2})\b/i);
  // Reject if it looks like a VRN: letters+digits+letters pattern BUT does NOT end in digit+2letters (inward code)
  // e.g. V20ALA = VRN (ends in ALA not 0AL), cv339bt = postcode (ends in 9BT — digit+2letters ✓)
  const looksLikeVrnPostcode = postcodeMatch &&
    /^[A-Z]{1,3}\d{1,4}[A-Z]{1,3}$/i.test(postcodeMatch[1].replace(/\s/g, '')) &&
    !/\d[A-Z]{2}$/i.test(postcodeMatch[1].replace(/\s/g, ''));
  const looksLikePostcode = !!postcodeMatch && !looksLikeVrnPostcode && postcodeMatch[1].length >= 4;
  if (!session.contactPostcode && looksLikePostcode && postcodeMatch) {
    args.postcode = postcodeMatch[1].replace(/\s+/g, '').toUpperCase();
  }

  // Treat as house number/name once we have postcode (no confirmation step needed)
  const isYes = /^(yes|yeah|yep|yup|correct|sure|ok|okay)$/i.test(text.trim());
  const isNo = /^(no|nope|wrong|incorrect)$/i.test(text.trim());
  // Exclude VRN-like strings (e.g. V20ALA, AB12CDE) — letters+digits+letters but NOT ending in digit+2letters
  const looksLikeVrn = /^[A-Z]{1,3}\d{1,4}[A-Z]{1,3}$/i.test(text.trim()) && !/\d[A-Z]{2}$/i.test(text.trim());
  const isLikelyHouseNumber = /^[A-Za-z0-9\-\s,\.]{1,40}$/.test(text) &&
    !emailMatch && !phoneMatch && !postcodeMatch &&
    !isYes && !isNo && !looksLikeVrn &&
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
    // Note: houseNumber is NOT hydrated from history — it's always the last thing asked,
    // and hydrating it from history causes VRNs (e.g. V20ALA) to be mistaken for house numbers.
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
        name: 'confirm_booking',
        description: 'Call this when customer responds to the "would you like to book?" question. confirmed=true if they want to proceed, false if not.',
        parameters: {
          type: 'object',
          properties: {
            confirmed: { type: 'boolean', description: 'True if customer wants to book, false if they just wanted the quote' },
          },
          required: ['confirmed'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'select_timeslot',
        description: 'Select a booking timeslot based on customer preference. Only call this AFTER confirm_booking(confirmed=true) has been called AND the customer has named a specific date/time from the options you presented.',
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

      case 'confirm_booking':
        return await handleConfirmBooking(args, session, conversationId);
      
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
  let { first_name, last_name = '', intent, service_hint = '' } = args;

  // Strip noise words that creep in when customers type multiple things on one line
  // e.g. "dandan" from "dan" + "quote", "v20alaquote" from reg + intent
  const noiseWords = /\b(quote|booking|book|service|mot|call|please|thanks|hi|hello|hey)\b/gi;
  first_name = (first_name || '').replace(noiseWords, '').replace(/\s+/g, ' ').trim();
  last_name = (last_name || '').replace(noiseWords, '').replace(/\s+/g, ' ').trim();

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
    const hourLondon2 = parseInt(new Date().toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hour12: false }), 10);
    const timeGreeting2 = hourLondon2 < 12 ? 'morning' : hourLondon2 < 17 ? 'afternoon' : 'evening';
    const firstName2 = first_name.charAt(0).toUpperCase() + first_name.slice(1).toLowerCase();
    return `Customer wants to leave a message.\nSay: "Good ${timeGreeting2}, ${firstName2}! What can I help you with?"\nWait for their message, then call take_message.`;
  }
  
  // Booking or quote flow
  session.step = Step.NEED_VRN;
  await saveSession(conversationId, session);
  console.log(`[SAVE_NAME] Session saved for booking intent`);

  // Build a time-appropriate greeting so Leah sounds human and aware of the time of day
  const hourLondon = parseInt(new Date().toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hour12: false }), 10);
  const timeGreeting = hourLondon < 12 ? 'morning' : hourLondon < 17 ? 'afternoon' : 'evening';
  const firstName = first_name.charAt(0).toUpperCase() + first_name.slice(1).toLowerCase();

  return `Name saved: ${firstName}.\nIntent: ${intent}${service_hint ? ` for ${service_hint}` : ''}.\n\nSay two separate messages:\n1. "Good ${timeGreeting}, ${firstName}!" (warm, brief — just a greeting)\n2. "What's your vehicle registration?" (new bubble — just the question, nothing else)\nDo NOT combine them. Wait for registration, then call lookup_vehicle.`;
}

async function handleLookupVehicle(args: any, session: ChatSession, conversationId: string): Promise<string> {
  const { registration, confirmed = false } = args;
  let normalized = registration.replace(/\s+/g, '').toUpperCase();
  
  console.log(`[LOOKUP_VEHICLE] ${normalized}, confirmed: ${confirmed}`);
  
  if (!GH_CUSTOMER_ID || !GH_API_KEY) {
    console.error(`[GARAGEHIVE_MISCONFIGURED] conversationId=${conversationId} — GarageHive credentials missing (GH_CUSTOMER_ID=${!!GH_CUSTOMER_ID}, GH_API_KEY=${!!GH_API_KEY}). Check integrationProviderConfig in Agent Configurations for this garage.`);
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
    session.vehicleMake = make.toLowerCase().split(' ').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    session.vehicleModel = model.toLowerCase().split(' ').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    session.step = Step.CONFIRMING_VEHICLE;
    await saveSession(conversationId, session);
    
    console.log(`[LOOKUP_VEHICLE] Found: ${session.vehicleMake} ${session.vehicleModel}, session: ${sessionId}`);
    
    return `Vehicle found: ${session.vehicleMake} ${session.vehicleModel} (${winningReg}).\nNOW call confirm_vehicle(confirmed=true) immediately — ZERO SPEECH. Do not wait for customer input.`;
    
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

  if (session.step === Step.NEED_TIMESLOT && session.serviceSelectedName && session.timeslotsAvailable && session.timeslotsAvailable.length > 0) {
    console.log('[STATE_GUARD] select_service called again after service already set — re-presenting timeslots');
    const firstSlots = session.timeslotsAvailable.slice(0, 3).map((t: any) => {
      return `${formatDateNaturally(t.date)} at ${formatTimeNaturally(t.time)}`;
    }).join(', or ');
    const makeTitle = (session.vehicleMake || '').toLowerCase().split(' ').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const modelTitle = (session.vehicleModel || '').toLowerCase().split(' ').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const priceNum = parseFloat(String(session.servicePrice));
    const priceDisplay = (!session.servicePrice || isNaN(priceNum) || priceNum < 1) ? 'POA' : `£${priceNum.toFixed(2).replace(/\.00$/, '')}`;
    return `SERVICE_ALREADY_SET: ${session.serviceSelectedName} (${priceDisplay}).\nSay: "A ${session.serviceSelectedName} for your ${makeTitle} ${modelTitle} is ${priceDisplay}. The earliest I have is ${firstSlots} — or do you have a particular date in mind?"\nWhen the customer responds, call select_timeslot with whatever they say.`;
  }

  console.log(`[SELECT_SERVICE] Looking for: ${service_name}`);

  if (!session.servicesAvailable || session.servicesAvailable.length === 0) {
    return `No services loaded yet. Call confirm_vehicle first.`;
  }

  // ── Service advisor: if customer says generic "service", recommend level based on last service date ──
  const genericServiceTerms = ['service', 'a service', 'servicing', 'car service', 'vehicle service'];
  if (genericServiceTerms.includes(service_name.toLowerCase().trim()) && !session.diagnosticComplete) {
    const availableLevels: Record<string, any> = {};
    for (const svc of session.servicesAvailable) {
      const n = svc.name.toLowerCase();
      if (/basic|bronze/.test(n)) availableLevels.basic = svc;
      else if (/interim|silver|mid/.test(n)) availableLevels.interim = svc;
      else if (/full|gold|major/.test(n)) availableLevels.full = svc;
    }
    if (Object.keys(availableLevels).length > 0) {
      const fmt = (svc: any) => {
        const p = parseFloat(svc.price || svc.totalPrice || '0');
        return p > 0 ? `£${p.toFixed(0)}` : 'POA';
      };
      const lines = [];
      if (availableLevels.basic) lines.push(`- Less than 6 months ago → ${availableLevels.basic.name} (${fmt(availableLevels.basic)})`);
      if (availableLevels.interim) lines.push(`- 6–12 months ago → ${availableLevels.interim.name} (${fmt(availableLevels.interim)})`);
      if (availableLevels.full) lines.push(`- Over 12 months / not sure → ${availableLevels.full.name} (${fmt(availableLevels.full)})`);
      session.diagnosticComplete = true; // prevents re-running
      await saveSession(conversationId, session);
      return `SERVICE ADVISOR: Customer said "service" without specifying type.\n\nAsk: "When was your car last serviced?"\n\nBased on their answer, recommend:\n${lines.join('\n')}\n\nSay naturally: "Based on that, I'd recommend a [Service Name] — shall I book that in?"\nOnce they agree, call select_service again with the specific service name.`;
    }
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
      // No online timeslots — tell customer and collect contact details via the normal fast-path
      session.notes = (session.notes ? session.notes + ' | ' : '') + `Callback requested: no online availability for ${serviceName}`;
      session.step = Step.NEED_CONTACT;
      await saveSession(conversationId, session);
      const nextAsk = session.contactPhone
        ? (session.contactEmail ? `What's your postcode?` : `Can I grab your email address?`)
        : `Can I just grab a contact number?`;
      return `No online slots for ${serviceName}.
Say: "I'm sorry, I don't have any online availability showing for that at the moment — it could be the team need to assess it first. Let me take your details and someone will give you a call to get you sorted. ${nextAsk}"
Wait for their response.`;
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
      session.step = Step.NEED_BOOKING_CONFIRM;
      await saveSession(conversationId, session);
      return `QUOTE: ${serviceName} for the ${makeTitle} ${modelTitle} is ${priceDisplay}.
Say: "A ${serviceName} for your ${makeTitle} ${modelTitle} is ${priceDisplay}. Would you like me to book that in for you?"
Call confirm_booking(confirmed=true) if yes, confirm_booking(confirmed=false) if no.`;
    }

    // Check if drop-off booking applies for this service
    const isDropOff = DROP_OFF_ENABLED && !DROP_OFF_EXCLUDE_SERVICES.some(
      (excl: string) => serviceName.toLowerCase().includes(excl.toLowerCase())
    );
    session.useDropOffBooking = isDropOff;
    await saveSession(conversationId, session);

    if (isDropOff) {
      // Drop-off: customer picks a date only, no specific time needed
      const firstDates = [...new Set(timeslots.map((t: any) => t.date))].slice(0, 3)
        .map((d: string) => formatDateNaturally(d)).join(', or ');
      return `SERVICE_SET (DROP-OFF): ${serviceName} (${priceDisplay}).
Say: "A ${serviceName} for your ${makeTitle} ${modelTitle} is ${priceDisplay}. For this one you can ${DROP_OFF_MESSAGE}. The first available date is ${firstDates} — or do you have a particular date in mind?"
When the customer responds, call select_timeslot with whatever they say.`;
    }

    return `SERVICE_SET: ${serviceName} (${priceDisplay}).
Say: "A ${serviceName} for your ${makeTitle} ${modelTitle} is ${priceDisplay}. The earliest I have is ${firstSlots} — or do you have a particular date in mind?"
When the customer responds, call select_timeslot with whatever they say.`;
    
  } catch (error: any) {
    console.error('[SELECT_SERVICE] API error:', error);
    return `Failed to set service.\nSay: "Let me take your details and the team will book that in for you." Then call take_message.`;
  }
}

async function handleConfirmBooking(args: any, session: ChatSession, conversationId: string): Promise<string> {
  const { confirmed } = args;

  if (!confirmed) {
    return `Customer doesn't want to book. Say: "No problem at all! If you change your mind, just give us a call." Then call take_message with their phone number.`;
  }

  if (!session.timeslotsAvailable || session.timeslotsAvailable.length === 0) {
    return `No timeslots available. Say: "Let me take your details and the team will be in touch to get you booked in." Then call take_message.`;
  }

  session.step = Step.NEED_TIMESLOT;
  await saveSession(conversationId, session);

  const firstSlots = session.timeslotsAvailable.slice(0, 3).map((t: any) =>
    `${formatDateNaturally(t.date)} at ${formatTimeNaturally(t.time)}`
  ).join(', or ');

  return `SLOTS: The earliest available are ${firstSlots}.
Say: "The earliest I have is ${firstSlots} — or do you have a particular date in mind?"
When the customer responds, call select_timeslot with whatever they say.`;
}

async function handleSelectTimeslot(args: any, session: ChatSession, conversationId: string): Promise<string> {
  const { preference } = args;

  if (session.step === Step.NEED_CONTACT && session.bookingDate && session.bookingTime) {
    console.log('[STATE_GUARD] Ignoring select_timeslot during NEED_CONTACT');
    return getNextContactInstruction(session);
  }

  if (session.step === Step.NEED_SLOT_CONFIRM && session.pendingSlotDate && session.pendingSlotTime) {
    console.log('[STATE_GUARD] Already have a pending slot, re-confirming');
    const dateNatural = formatDateNaturally(session.pendingSlotDate);
    const timeNatural = formatTimeNaturally(session.pendingSlotTime);
    return `Proposed slot: ${dateNatural} at ${timeNatural}.\n\nSay ONLY: "I've got ${dateNatural} at ${timeNatural} — does that work for you?" and STOP.`;
  }

  console.log(`[SELECT_TIMESLOT] Preference: "${preference}", dropOff: ${session.useDropOffBooking}`);

  if (!session.timeslotsAvailable || session.timeslotsAvailable.length === 0) {
    return `No timeslots loaded. Call select_service first.`;
  }

  // Drop-off booking: pick the first slot on the requested date, skip time selection
  if (session.useDropOffBooking) {
    // Try to find a date match from the preference
    const dateMatch = matchTimeslot(preference, session.timeslotsAvailable);
    // Find the first slot on that date (or first overall if no match)
    const targetDate = dateMatch?.date || session.timeslotsAvailable[0].date;
    const slotsOnDate = session.timeslotsAvailable.filter((t: any) => t.date === targetDate);
    const dropOffSlot = slotsOnDate[0] || session.timeslotsAvailable[0];

    session.pendingSlotDate = dropOffSlot.date;
    session.pendingSlotTime = dropOffSlot.time;
    session.step = Step.NEED_SLOT_CONFIRM;
    console.log(`[SELECT_TIMESLOT] Drop-off slot set: ${dropOffSlot.date} (time hidden from customer)`);
    await saveSession(conversationId, session);

    const dateNatural = formatDateNaturally(dropOffSlot.date);
    return `Proposed drop-off slot: ${dateNatural}.

Say ONLY: "I've got you down for ${dateNatural} — just ${DROP_OFF_MESSAGE}. Does that work for you?" and STOP. Do not mention a specific time. Wait for confirmation.`;
  }

  const matched = matchTimeslot(preference, session.timeslotsAvailable);

  if (!matched) {
    // No match — tell the agent to explain what’s available and ask again
    const firstSlots = session.timeslotsAvailable.slice(0, 3).map((t: any) =>
      `${formatDateNaturally(t.date)} at ${formatTimeNaturally(t.time)}`
    ).join(', or ');
    const lastSlot = session.timeslotsAvailable[session.timeslotsAvailable.length - 1];
    return `NO_MATCH: "${preference}" didn't match any available slot. Online availability ends ${formatDateNaturally(lastSlot.date)}.
Say: "I'm afraid our online diary only goes up to ${formatDateNaturally(lastSlot.date)}. The slots I have are ${firstSlots} — would any of those work?"
When they choose, call select_timeslot again.`;
  }
  
  const { date, time } = matched;

  console.log(`[SELECT_TIMESLOT] Matched: ${date} at ${time}`);

  // Check if the preference message also contains a note (e.g. "tomorrow at 8:30, also got a knocking noise")
  const rawPref: string = args.preference || '';
  const notePattern = /(?:also|and|btw|by the way|ps|p\.s\.?|additionally|there[''s]*s?|it[''s]*s?|she[''s]*s?)\s+(.{10,})/i;
  const noteInPref = rawPref.match(notePattern);
  if (noteInPref) {
    session.notes = (session.notes ? session.notes + ' | ' : '') + `Customer note: ${noteInPref[1].trim()}`;
    console.log(`[SELECT_TIMESLOT] Extracted note from preference: ${noteInPref[1].trim()}`);
  }

  // Store as pending slot — don't book yet, ask customer to confirm first
  session.pendingSlotDate = date;
  session.pendingSlotTime = time;
  session.step = Step.NEED_SLOT_CONFIRM;
  console.log(`[SELECT_TIMESLOT] Pending slot set: ${date} at ${time}, waiting for confirmation`);
  await saveSession(conversationId, session);

  const dateNatural = formatDateNaturally(date);
  const timeNatural = formatTimeNaturally(time);

  return `Proposed slot: ${dateNatural} at ${timeNatural}.

Say ONLY: "I've got ${dateNatural} at ${timeNatural} — does that work for you?" and STOP. Do not ask for contact details yet. Wait for them to confirm.`;
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
    } catch (error: any) {
      // 404 = invalid postcode — ask the customer to check it rather than silently saving
      const status = error?.response?.status;
      if (status === 404) {
        console.log(`[SET_CONTACT] Invalid postcode "${cleanPostcode}" (404), asking customer to retry`);
        // Don't save — just fall through so the "Need postcode" branch fires again
      } else {
        // Network or other error — accept it and move on
        session.contactPostcode = postcode;
        console.log(`[SET_CONTACT] Postcode lookup failed (${status || 'network'}), using anyway`);
      }
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
    const hadAttempt = postcode && postcode.length > 0;
    const msg = hadAttempt
      ? `Hmm, I couldn't find that postcode — could you double-check it?`
      : `What's your postcode?`;
    return `Need postcode.\n\nSay: "${msg}"\nWait for postcode.`;
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

  // Flag conversation as needing attention so it shows up in the Messages inbox
  await prisma.chatConversation.updateMany({
    where: { id: conversationId },
    data: { needsAttention: true },
  });
  
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
  'bearing','wheel bearing','hub','steering','drifting','pulling','tyre','tire',
  'brake','braking','stopping','creaking','rubbing','grinding','scraping',
];

async function specialistDiagnosticQuestions(symptomText: string): Promise<string[] | null> {
  const lower = symptomText.toLowerCase();

  // Skip diagnostic questions for clearly named standard services (MOT, oil change, etc.)
  const standardServices = /^\s*(mot|oil change|oil service|full service|interim service|major service|tyre(s)?|tire(s)?|tyre change|wheel alignment|wheel balancing|battery|bulb|wiper|air con|air conditioning|recharge|flush|brake pads|brake discs|brake fluid|coolant flush|gearbox oil|transmission service)\s*$/i;
  if (standardServices.test(lower)) return null;

  // Check for symptom keywords OR specific parts that need diagnostic questions
  const hasSymptomKeyword = SYMPTOM_KEYWORDS.some(k => lower.includes(k));
  // Also run diagnostic if it mentions a specific part but not as a clear replacement request
  const mentionsPart = /bearing|hub|joint|cv|driveshaft|caliper|shock|strut|arm|ball|link|mount/i.test(lower);

  if (!hasSymptomKeyword && !mentionsPart) return null;

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

  const prefLower = preference.toLowerCase().trim();

  // Extract a time-of-day hour from text — only matches valid hours (0-23) with am/pm,
  // or HH:MM format. Ignores bare numbers that could be day-of-month (e.g. "25th").
  function extractPrefHour(text: string): number | null {
    // HH:MM or HH:MMam/pm — trailing \b removed so "9:30am" matches correctly
    const hhmm = text.match(/\b(\d{1,2}):(\d{2})/);
    if (hhmm) {
      let h = parseInt(hhmm[1]);
      if (h >= 0 && h <= 23) return h;
    }
    // Number followed by am/pm — negative lookbehind prevents matching "30am" from "9:30am"
    const ampm = text.match(/(?<![\d:])\b(\d{1,2})\s*(am|pm)\b/i);
    if (ampm) {
      let h = parseInt(ampm[1]);
      const mer = ampm[2].toLowerCase();
      if (mer === 'pm' && h < 12) h += 12;
      if (mer === 'am' && h === 12) h = 0;
      if (h >= 0 && h <= 23) return h;
    }
    return null; // Don't extract bare numbers — they're probably dates
  }

  function closestByTime(candidates: any[], prefHour: number | null): any {
    if (prefHour === null || candidates.length === 1) return candidates[0];
    return candidates.reduce((best, t) => {
      const tH = parseInt(t.time.split(':')[0]);
      const bH = parseInt(best.time.split(':')[0]);
      return Math.abs(tH - prefHour) <= Math.abs(bH - prefHour) ? t : best;
    });
  }

  // "First", "earliest", "ASAP"
  if (/\b(first|earliest|asap|soonest)\b/.test(prefLower)) return timeslots[0];

  // "Last", "latest"
  if (/\b(last|latest)\b/.test(prefLower)) return timeslots[timeslots.length - 1];

  // "Later", "after that", "something later", "end of the week", "next month"
  if (/\b(later|after that|end of|next month|further out|something later)\b/.test(prefLower)) {
    const ph = extractPrefHour(prefLower);
    return closestByTime(timeslots, ph) ?? timeslots[timeslots.length - 1];
  }

  // "Today" / "Tomorrow"
  if (/\btoday\b/.test(prefLower)) {
    const todayStr = new Date().toISOString().split('T')[0];
    const matches = timeslots.filter(t => t.date === todayStr);
    if (matches.length > 0) return closestByTime(matches, extractPrefHour(prefLower));
  }
  if (/\btomorrow\b/.test(prefLower)) {
    const d = new Date(); d.setDate(d.getDate() + 1);
    const matches = timeslots.filter(t => t.date === d.toISOString().split('T')[0]);
    if (matches.length > 0) return closestByTime(matches, extractPrefHour(prefLower));
  }

  // "Next week"
  if (/\bnext week\b/.test(prefLower)) {
    const d = new Date(); d.setDate(d.getDate() + 7);
    const matches = timeslots.filter(t => t.date >= d.toISOString().split('T')[0]);
    if (matches.length > 0) return closestByTime(matches, extractPrefHour(prefLower));
  }

  // Named day — with "next" prefix means skip to the week AFTER the coming occurrence
  // e.g. today=Sunday 23 Feb, "next thursday" = 5 Mar (not 26 Feb which is "this thursday")
  const dayNames = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const isNext = /\bnext\b/.test(prefLower);
  for (const dayName of dayNames) {
    if (new RegExp(`\\b${dayName}\\b`).test(prefLower)) {
      const today = new Date();
      const todayDow = today.getDay(); // 0=Sun
      const targetDow = dayNames.indexOf(dayName);

      // How many days until the next occurrence of targetDow
      let daysUntil = (targetDow - todayDow + 7) % 7;
      if (daysUntil === 0) daysUntil = 7; // "thursday" when today is thursday = next week

      // "next thursday" skips past the coming one to the one after
      if (isNext && daysUntil <= 7) daysUntil += 7;

      const target = new Date(today);
      target.setDate(today.getDate() + daysUntil);
      const targetDateStr = target.toISOString().split('T')[0];

      // Find slots on that exact date, or the nearest date after it
      let matches = timeslots.filter(t => t.date === targetDateStr);
      if (matches.length === 0) {
        // No exact match — find closest slot on or after the target date
        matches = timeslots.filter(t => t.date >= targetDateStr);
      }
      if (matches.length > 0) return closestByTime(matches, extractPrefHour(prefLower));
    }
  }

  // Month name — check BEFORE day-of-month so "5th March" filters by month first
  // e.g. "Thursday 5th March" → find slots in March, then pick day 5, then closest time
  const monthNames = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  let monthFilter: number | null = null;
  for (let mi = 0; mi < monthNames.length; mi++) {
    if (new RegExp(`\\b${monthNames[mi]}\\b`).test(prefLower)) {
      monthFilter = mi;
      break;
    }
  }
  if (monthFilter !== null) {
    const inMonth = timeslots.filter(t => new Date(t.date + 'T12:00:00').getMonth() === monthFilter);
    if (inMonth.length === 0) return null; // Month mentioned but no slots — let OpenAI explain
    // Try to also narrow by day-of-month within the month
    const domMatch = prefLower.match(/\b(\d{1,2})(st|nd|rd|th)?\b/);
    if (domMatch) {
      const dayNum = parseInt(domMatch[1]);
      if (dayNum >= 1 && dayNum <= 31) {
        const onDay = inMonth.filter(t => new Date(t.date + 'T12:00:00').getDate() === dayNum);
        if (onDay.length > 0) return closestByTime(onDay, extractPrefHour(prefLower));
        // Day not available in that month — return nearest slot in that month
        return closestByTime(inMonth, extractPrefHour(prefLower));
      }
    }
    return closestByTime(inMonth, extractPrefHour(prefLower));
  }

  // Specific day-of-month only (no month name) — "the 25th", "25th", "on the 26th"
  const dayOfMonthMatch = prefLower.match(/\b(\d{1,2})(st|nd|rd|th)\b/);
  if (dayOfMonthMatch) {
    const dayNum = parseInt(dayOfMonthMatch[1]);
    if (dayNum >= 1 && dayNum <= 31) {
      const matches = timeslots.filter(t => new Date(t.date + 'T12:00:00').getDate() === dayNum);
      if (matches.length > 0) return closestByTime(matches, extractPrefHour(prefLower));
    }
  }

  // "Morning" / "Afternoon" / "Evening"
  if (/\bmorning\b/.test(prefLower)) {
    const matches = timeslots.filter(t => parseInt(t.time.split(':')[0]) < 12);
    if (matches.length > 0) return matches[0];
  }
  if (/\b(afternoon|pm)\b/.test(prefLower)) {
    const matches = timeslots.filter(t => parseInt(t.time.split(':')[0]) >= 12);
    if (matches.length > 0) return matches[0];
  }

  // Specific time (HH:MM or Xam/Xpm) — find closest slot across all dates
  const prefHour = extractPrefHour(prefLower);
  if (prefHour !== null) {
    return closestByTime(timeslots, prefHour);
  }

  // No match found — fall through to OpenAI
  return null;
}

function buildSystemPromptV2(config: any, knowledgeDocuments: any[], _isOpen: boolean, session: ChatSession): string {
  const branchName = config.branchName || 'our garage';

  // ── Persona ──────────────────────────────────────────────────────────────
  let prompt = `You are Leah, the friendly AI receptionist at ${branchName}, a British car repair garage.
${config.greetingLine ? config.greetingLine + '\n' : ''}
PERSONALITY & CHARACTER:
- You're warm, down-to-earth, and genuinely helpful — like the friendly person on the front desk who actually knows their stuff
- British in tone: natural, unpretentious, occasionally a little light-hearted but always professional
- You care about the customer, not just the booking — if they seem stressed about their car, acknowledge it
- You speak plainly. No corporate waffle, no filler phrases like "Certainly!" or "Absolutely!" or "Of course!" — just natural responses
- Use British English: "tyre" not "tire", "bonnet" not "hood", "boot" not "trunk", "MOT", "service" etc.
- Contractions are fine: "I'll", "we've", "don't", "that's"
- Keep it concise — you're busy and so are they. One or two sentences is usually enough
- When something goes wrong or you can't help, be honest and warm about it rather than robotic
- You can use light humour where natural (e.g. if someone apologises for not knowing their reg, "No worries — we'll figure it out!")
- Never sound like a bot. Never use lists or bullet points in chat. Never start a message with "Sure," or "Great!"
- Address the customer by first name once you know it, but don't overdo it

TONE EXAMPLES:
- Instead of "Certainly! I'd be happy to help you with that." → say "Of course — let me sort that for you."
- Instead of "Great! Let me look that up for you." → say "Leave it with me, I'll take a look."
- Instead of "I'm sorry to hear that." → say "Ah, that's not ideal — let's see what we can do."
- Instead of "Unfortunately we do not have availability." → say "We're a bit tight on slots online at the moment — it might be worth giving us a ring."

`;


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

  // ── Current date & time (London) ─────────────────────────────────────────
  const nowLondon = new Date().toLocaleString('en-GB', {
    timeZone: 'Europe/London',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
  prompt += `Current date and time: ${nowLondon}\n`;
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

  // ── Available timeslots — inject when in timeslot selection so OpenAI can handle any natural language ──
  if (session.step === Step.NEED_TIMESLOT && session.timeslotsAvailable && session.timeslotsAvailable.length > 0) {
    const slotLines = session.timeslotsAvailable.map((t: any) =>
      `- ${formatDateNaturally(t.date)} at ${formatTimeNaturally(t.time)} (${t.date} ${t.time})`
    ).join('\n');
    const lastSlot = session.timeslotsAvailable[session.timeslotsAvailable.length - 1];
    prompt += `\nAVAILABLE TIMESLOTS (these are ALL available slots — no others exist beyond ${formatDateNaturally(lastSlot.date)}):\n${slotLines}\n`;
    prompt += `When the customer says what time they'd like, call select_timeslot with their preference. If they ask for a date/time not in this list (e.g. "what about March?"), explain politely that online availability only goes up to ${formatDateNaturally(lastSlot.date)} and offer the closest available slot. Do NOT invent slots.\n`;
  }

  prompt += '\n';

  // ── Outbound campaign shortcut ────────────────────────────────────────────
  if (session.outboundRegistration && !session.vrn) {
    const svcType = session.outboundServiceType === 'service' ? 'service' : 'MOT';
    prompt += `OUTBOUND CAMPAIGN REPLY: This customer replied to an outbound ${svcType} reminder. You already know:\n`;
    prompt += `- Their registration is ${session.outboundRegistration}\n`;
    if (session.outboundDueDate) prompt += `- ${svcType} is due on ${session.outboundDueDate}\n`;
    prompt += `Skip steps 1 and 2 below. Call lookup_vehicle('${session.outboundRegistration}') as your VERY FIRST action — do NOT ask the customer for their name or registration.\n\n`;
  }

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
- If you cannot proceed, offer to take a message for a callback
- If the customer says "quote", "how much", "what does it cost" or similar AFTER the vehicle is already confirmed, just tell them the price from the already-selected service in CURRENT STATE and continue the booking — do NOT call take_message, do NOT end the conversation
- Never say goodbye or end the chat unless the booking is fully confirmed AND all contact details have been collected\n`;

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
