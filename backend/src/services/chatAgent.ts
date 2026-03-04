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

// Booking session storage (in-memory for now, should be in Redis/DB for production)
const bookingSessions = new Map<string, any>();

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

    // Load GarageHive credentials from integration config
    console.log('[CHAT_AGENT] Integration Provider:', config.integrationProvider);
    console.log('[CHAT_AGENT] Has integration config:', !!config.integrationProviderConfig);

    if (config.integrationProviderConfig && typeof config.integrationProviderConfig === 'object') {
      const ghConfig = config.integrationProviderConfig as any;
      GH_CUSTOMER_ID = ghConfig.ghCustomerId || ghConfig.customerId;
      GH_API_KEY = ghConfig.ghApiKey || ghConfig.apiKey;
      GH_LOCATION_ID = ghConfig.ghLocationId || ghConfig.locationId || '23';
      console.log('[CHAT_AGENT] Loaded GH config:', {
        hasCustomerId: !!GH_CUSTOMER_ID,
        hasApiKey: !!GH_API_KEY,
        locationId: GH_LOCATION_ID,
      });
    }

    // Build conversation context (reduced to 6 to save tokens)
    const previousMessages = await prisma.chatMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
      take: 6,
    });

    // Check for active booking session
    const activeSession = bookingSessions.get(conversationId);
    const systemPrompt = buildSystemPrompt(config, garage.knowledgeDocuments, isOpen, activeSession);

    // Build messages with function calling support
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

    // Call OpenAI with function calling
    // Use lower temperature if there's an active booking session for more reliable behavior
    const temperature = activeSession ? 0.5 : 0.9;

    let response = await getOpenAI().chat.completions.create({
      model: 'gpt-4o',
      messages,
      temperature,
      max_tokens: 200,
      tools: getBookingTools(),
      tool_choice: 'auto',
    });

    // Handle function calls
    let iterations = 0;
    const maxIterations = 5;

    while (response.choices[0]?.finish_reason === 'tool_calls' && iterations < maxIterations) {
      iterations++;
      const toolCalls = response.choices[0].message.tool_calls;

      if (!toolCalls) break;

      // Add assistant message with tool calls
      messages.push(response.choices[0].message);

      // Execute each tool call
      for (const toolCall of toolCalls) {
        if (toolCall.type !== 'function') continue;

        const functionName = toolCall.function.name;
        const functionArgs = JSON.parse(toolCall.function.arguments);

        console.log(`[CHAT_AGENT] Calling tool: ${functionName}`, functionArgs);

        const functionResult = await executeBookingTool(
          functionName,
          functionArgs,
          conversationId
        );

        // Add tool response
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(functionResult),
        });
      }

      // Get next response
      response = await getOpenAI().chat.completions.create({
        model: 'gpt-4o',
        messages,
        temperature,
        max_tokens: 200,
        tools: getBookingTools(),
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
    console.error('Chat agent error:', error);
    throw error;
  }
}

function getBookingTools(): OpenAI.Chat.ChatCompletionTool[] {
  return [
    {
      type: 'function',
      function: {
        name: 'gh_initiate_booking',
        description: 'Start a new booking session with the customer\'s vehicle registration number. Call this first when a customer wants to book a service.',
        parameters: {
          type: 'object',
          properties: {
            registration: {
              type: 'string',
              description: 'The vehicle registration number (e.g., AB12 CDE)',
            },
          },
          required: ['registration'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'gh_get_services',
        description: 'Get the list of available services with their service_ids. Returns an array of services, each with an "id" field. Call this ONCE after initiating a booking to get the service options.',
        parameters: {
          type: 'object',
          properties: {},
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'gh_set_service',
        description: 'Set the selected service for booking. After matching the customer\'s request to a service from gh_get_services, call this with the service_price_id. The system will also accept "1", "2", etc. as shortcuts.',
        parameters: {
          type: 'object',
          properties: {
            service_id: {
              type: 'string',
              description: 'The service_price_id from the matched service in gh_get_services response, OR a number like "1", "2" for shortcuts.',
            },
          },
          required: ['service_id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'gh_get_additional_services',
        description: 'Get optional additional services/extras after setting main service. MUST be called before listing timeslots.',
        parameters: {
          type: 'object',
          properties: {},
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'gh_set_additional_services',
        description: 'Add optional extras/additional services. Only call if customer wants to add extras.',
        parameters: {
          type: 'object',
          properties: {
            service_id: {
              type: 'string',
              description: 'The ID of the additional service to add',
            },
          },
          required: ['service_id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'gh_list_timeslots',
        description: 'Get available appointment times. Call this AFTER gh_get_additional_services.',
        parameters: {
          type: 'object',
          properties: {},
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'gh_set_timeslot',
        description: 'Book a specific time slot.',
        parameters: {
          type: 'object',
          properties: {
            timeslot_id: {
              type: 'string',
              description: 'The ID of the time slot to book',
            },
          },
          required: ['timeslot_id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'gh_set_contact_info',
        description: 'Set the customer contact information to complete the booking.',
        parameters: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Customer full name',
            },
            phone: {
              type: 'string',
              description: 'Customer phone number',
            },
            email: {
              type: 'string',
              description: 'Customer email address',
            },
          },
          required: ['name', 'phone'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'send_booking_link_sms',
        description: 'Send the online booking link via SMS to the customer. Use this if they prefer to book online themselves.',
        parameters: {
          type: 'object',
          properties: {
            phone_number: {
              type: 'string',
              description: 'Customer phone number in UK format (e.g., 07123456789 or +447123456789)',
            },
          },
          required: ['phone_number'],
        },
      },
    },
  ];
}

async function executeBookingTool(
  functionName: string,
  args: any,
  conversationId: string
): Promise<any> {
  const sessionData = bookingSessions.get(conversationId) || {};

  try {
    switch (functionName) {
      case 'gh_initiate_booking':
        return await ghInitiateBooking(args.registration, conversationId);

      case 'gh_get_services':
        if (!sessionData.session_id) {
          return { error: 'No active booking session. Please provide vehicle registration first.' };
        }
        return await ghGetServices(sessionData.session_id, conversationId);

      case 'gh_set_service':
        if (!sessionData.session_id) {
          return { error: 'No active booking session' };
        }
        return await ghSetService(sessionData.session_id, args.service_id, conversationId);

      case 'gh_get_additional_services':
        if (!sessionData.session_id) {
          return { error: 'No active booking session' };
        }
        return await ghGetAdditionalServices(sessionData.session_id);

      case 'gh_set_additional_services':
        if (!sessionData.session_id) {
          return { error: 'No active booking session' };
        }
        return await ghSetAdditionalServices(sessionData.session_id, args.service_id);

      case 'gh_list_timeslots':
        if (!sessionData.session_id) {
          return { error: 'No active booking session' };
        }
        return await ghListTimeslots(sessionData.session_id);

      case 'gh_set_timeslot':
        if (!sessionData.session_id) {
          return { error: 'No active booking session' };
        }
        return await ghSetTimeslot(sessionData.session_id, args.timeslot_id);

      case 'gh_set_contact_info':
        if (!sessionData.session_id) {
          return { error: 'No active booking session' };
        }
        return await ghSetContactInfo(sessionData.session_id, args.name, args.phone, args.email);

      case 'send_booking_link_sms':
        return await sendBookingLinkSms(args.phone_number);

      default:
        return { error: 'Unknown function' };
    }
  } catch (error: any) {
    console.error(`Error executing ${functionName}:`, error);
    return { error: error.message || 'Function execution failed' };
  }
}

// GarageHive API implementations
async function ghInitiateBooking(registration: string, conversationId: string): Promise<any> {
  const instance = GH_CUSTOMER_ID;
  const locationId = parseInt(GH_LOCATION_ID || '23');

  const headers: any = { 'Content-Type': 'application/json' };
  if (GH_API_KEY) {
    headers['Authorization'] = `Bearer ${GH_API_KEY}`;
  }

  const normalizedReg = registration.toUpperCase().replace(/\s+/g, '');

  try {
    // Step 1: Init booking
    const initResp = await axios.post(
      `https://onlinebooking.garagehive.co.uk/api/external-booking/${instance}/init`,
      { locationId },
      { headers, timeout: 20000 }
    );

    const booking = initResp.data.booking || {};
    const sessionId = booking.session_id || initResp.data.sessionId || initResp.data.session_id;

    if (!sessionId) {
      console.error('[GH_INITIATE_BOOKING] No session_id in response:', initResp.data);
      return { error: 'Failed to get session ID', data: initResp.data };
    }

    // Step 2: Set vehicle info
    const vehicleResp = await axios.post(
      `https://onlinebooking.garagehive.co.uk/api/external-booking/${instance}/${sessionId}/set-vehicle-info`,
      {
        registration_no: normalizedReg,
        reg_no_country: 'GB',
        location_id: locationId,
      },
      { headers, timeout: 20000 }
    );

    // Store session
    bookingSessions.set(conversationId, {
      session_id: sessionId,
      registration: normalizedReg,
    });

    // Return the full vehicle data with session_id included (like basic_agent2.py)
    const vehicleData = vehicleResp.data;
    vehicleData.session_id = sessionId;

    console.log('[GH_INITIATE_BOOKING] Success:', { session_id: sessionId, registration: normalizedReg });
    return vehicleData;
  } catch (error: any) {
    // Return specific error from API if available
    const errorData = error.response?.data;
    const errorMsg = errorData?.message || errorData?.error || error.message;

    console.error('[GH_INITIATE_BOOKING] Error:', errorData || error.message);

    // If there's a specific error message from the API, return it so the AI can communicate it
    if (errorData) {
      return errorData;
    }

    return { error: `Failed to initiate booking: ${errorMsg}` };
  }
}

async function ghGetServices(sessionId: string, conversationId: string): Promise<any> {
  const instance = GH_CUSTOMER_ID;
  const headers: any = { 'Content-Type': 'application/json' };
  if (GH_API_KEY) headers['Authorization'] = `Bearer ${GH_API_KEY}`;

  try {
    const resp = await axios.get(
      `https://onlinebooking.garagehive.co.uk/api/external-booking/${instance}/${sessionId}/list-services`,
      { headers, timeout: 20000 }
    );

    // Store services in session for easy lookup
    const sessionData = bookingSessions.get(conversationId) || {};
    if (resp.data.services && Array.isArray(resp.data.services)) {
      sessionData.services = resp.data.services;
      sessionData.servicesShown = true; // Track that we showed services
      sessionData.awaitingServiceSelection = true; // Waiting for user to pick
      bookingSessions.set(conversationId, sessionData);
      console.log('[GH_GET_SERVICES] Stored', resp.data.services.length, 'services in session');
    }

    return resp.data;
  } catch (error: any) {
    const errorData = error.response?.data;
    console.error('[GH_GET_SERVICES] Error:', errorData || error.message);
    return errorData || { error: `Failed to get services: ${error.message}` };
  }
}

async function ghSetService(sessionId: string, serviceId: string, conversationId: string): Promise<any> {
  const instance = GH_CUSTOMER_ID;
  const headers: any = { 'Content-Type': 'application/json' };
  if (GH_API_KEY) headers['Authorization'] = `Bearer ${GH_API_KEY}`;

  // Smart service ID resolution: if it's a number like "1", "2", look it up in stored services
  let resolvedServiceId = serviceId;
  const sessionData = bookingSessions.get(conversationId);

  console.log(`[GH_SET_SERVICE] Session data:`, JSON.stringify(sessionData).substring(0, 300));
  console.log(`[GH_SET_SERVICE] Services array length:`, sessionData?.services?.length);

  if (sessionData?.services && /^\d+$/.test(serviceId)) {
    const index = parseInt(serviceId) - 1;
    console.log(`[GH_SET_SERVICE] Looking up index ${index} in services array`);

    if (index >= 0 && index < sessionData.services.length) {
      const service = sessionData.services[index];
      console.log(`[GH_SET_SERVICE] Found service:`, JSON.stringify(service));

      // Look for the price ID - GarageHive uses service_price_id
      resolvedServiceId = service.service_price_id || service.servicePriceID || service.id || service.service_id || serviceId;
      console.log(`[GH_SET_SERVICE] Mapped selection "${serviceId}" to service ID "${resolvedServiceId}"`);

      // Remove verbose logging after successful map
      console.log(`[GH_SET_SERVICE] ✓ Using service: ${service.name}`);
    } else {
      console.log(`[GH_SET_SERVICE] Index ${index} out of bounds (array length: ${sessionData.services.length})`);
    }
  } else {
    console.log(`[GH_SET_SERVICE] No services in session or serviceId is not a number`);
  }

  try {
    // GarageHive expects servicePriceIDs as an array
    const payload = { servicePriceIDs: [parseInt(resolvedServiceId)] };
    console.log(`[GH_SET_SERVICE] Calling API with payload:`, payload);

    const resp = await axios.post(
      `https://onlinebooking.garagehive.co.uk/api/external-booking/${instance}/${sessionId}/set-services`,
      payload,
      { headers, timeout: 20000 }
    );

    console.log(`[GH_SET_SERVICE] Success:`, resp.data);

    // Clear the awaiting flag since service was selected
    const sessionData = bookingSessions.get(conversationId) || {};
    sessionData.awaitingServiceSelection = false;
    bookingSessions.set(conversationId, sessionData);

    return resp.data;
  } catch (error: any) {
    const errorData = error.response?.data;
    console.error('[GH_SET_SERVICE] Error:', errorData || error.message);
    return errorData || { error: `Failed to set service: ${error.message}` };
  }
}

async function ghGetAdditionalServices(sessionId: string): Promise<any> {
  const instance = GH_CUSTOMER_ID;
  const headers: any = { 'Content-Type': 'application/json' };
  if (GH_API_KEY) headers['Authorization'] = `Bearer ${GH_API_KEY}`;

  try {
    const resp = await axios.get(
      `https://onlinebooking.garagehive.co.uk/api/external-booking/${instance}/${sessionId}/list-additional-services`,
      { headers, timeout: 20000 }
    );
    return resp.data;
  } catch (error: any) {
    const errorData = error.response?.data;
    console.error('[GH_GET_ADDITIONAL_SERVICES] Error:', errorData || error.message);
    return errorData || { error: `Failed to get additional services: ${error.message}` };
  }
}

async function ghSetAdditionalServices(sessionId: string, serviceId: string): Promise<any> {
  const instance = GH_CUSTOMER_ID;
  const headers: any = { 'Content-Type': 'application/json' };
  if (GH_API_KEY) headers['Authorization'] = `Bearer ${GH_API_KEY}`;

  try {
    const resp = await axios.post(
      `https://onlinebooking.garagehive.co.uk/api/external-booking/${instance}/${sessionId}/set-additional-services`,
      { addServicePriceID: parseInt(serviceId) },
      { headers, timeout: 20000 }
    );
    return resp.data;
  } catch (error: any) {
    const errorData = error.response?.data;
    console.error('[GH_SET_ADDITIONAL_SERVICES] Error:', errorData || error.message);
    return errorData || { error: `Failed to set additional service: ${error.message}` };
  }
}

async function ghListTimeslots(sessionId: string): Promise<any> {
  const instance = GH_CUSTOMER_ID;
  const headers: any = { 'Content-Type': 'application/json' };
  if (GH_API_KEY) headers['Authorization'] = `Bearer ${GH_API_KEY}`;

  console.log(`[GH_LIST_TIMESLOTS] Requesting timeslots for session ${sessionId}`);

  try {
    const resp = await axios.get(
      `https://onlinebooking.garagehive.co.uk/api/external-booking/${instance}/${sessionId}/list-timeslots`,
      { headers, timeout: 20000 }
    );

    console.log('[GH_LIST_TIMESLOTS] Response:', JSON.stringify(resp.data).substring(0, 500));

    // Check if response has timeslots
    if (resp.data && resp.data.timeslots) {
      console.log(`[GH_LIST_TIMESLOTS] Found ${resp.data.timeslots.length} timeslots`);
    } else if (resp.data && resp.data.error) {
      console.log('[GH_LIST_TIMESLOTS] API returned error:', resp.data.error);
    }

    return resp.data;
  } catch (error: any) {
    const errorData = error.response?.data;
    console.error('[GH_LIST_TIMESLOTS] Error:', JSON.stringify(errorData || error.message).substring(0, 500));
    return errorData || { error: `Failed to get available times: ${error.message}` };
  }
}

async function ghSetTimeslot(sessionId: string, timeslotId: string): Promise<any> {
  const instance = GH_CUSTOMER_ID;
  const headers: any = { 'Content-Type': 'application/json' };
  if (GH_API_KEY) headers['Authorization'] = `Bearer ${GH_API_KEY}`;

  try {
    const resp = await axios.post(
      `https://onlinebooking.garagehive.co.uk/api/external-booking/${instance}/${sessionId}/set-timeslot`,
      { timeslot_id: timeslotId },
      { headers, timeout: 20000 }
    );
    return resp.data;
  } catch (error: any) {
    const errorData = error.response?.data;
    console.error('[GH_SET_TIMESLOT] Error:', errorData || error.message);
    return errorData || { error: `Failed to book time slot: ${error.message}` };
  }
}

async function ghSetContactInfo(sessionId: string, name: string, phone: string, email?: string): Promise<any> {
  const instance = GH_CUSTOMER_ID;
  const headers: any = { 'Content-Type': 'application/json' };
  if (GH_API_KEY) headers['Authorization'] = `Bearer ${GH_API_KEY}`;

  try {
    const resp = await axios.post(
      `https://onlinebooking.garagehive.co.uk/api/external-booking/${instance}/${sessionId}/set-contact-info`,
      { name, phone, email },
      { headers, timeout: 20000 }
    );
    return resp.data;
  } catch (error: any) {
    const errorData = error.response?.data;
    console.error('[GH_SET_CONTACT_INFO] Error:', errorData || error.message);
    return errorData || { error: `Failed to save contact information: ${error.message}` };
  }
}

async function sendBookingLinkSms(phoneNumber: string): Promise<any> {
  // Implement SMS sending via Twilio or your SMS provider
  // For now, return a placeholder
  return {
    success: true,
    message: 'Booking link would be sent via SMS (not implemented yet)',
  };
}

function buildSystemPrompt(config: any, knowledgeDocuments: any[], isOpen: boolean, activeSession?: any): string {
  const branchName = config.branchName || 'our garage';

  let prompt = `You are Leah, the friendly receptionist at ${branchName}. You're here to help with bookings and answer questions about the garage. ${config.greetingLine || ''}\n\n`;

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

  // Booking instructions - only if GarageHive is configured
  const hasGarageHive = config.integrationProvider === 'garage_hive' ||
                        config.integrationProvider === 'garagehive' ||
                        (config.integrationProviderConfig &&
                         ((config.integrationProviderConfig as any).ghCustomerId ||
                          (config.integrationProviderConfig as any).customerId));

  console.log('[CHAT_AGENT] Has GarageHive?', hasGarageHive, {
    provider: config.integrationProvider,
    hasConfig: !!config.integrationProviderConfig,
    hasCustomerId: !!((config.integrationProviderConfig as any)?.ghCustomerId || (config.integrationProviderConfig as any)?.customerId),
  });

  if (hasGarageHive) {
    prompt += `\n🎯 NATURAL BOOKING FLOW:\n\n`;

    prompt += `**Step 1: Understand what they need**\n`;
    prompt += `- Listen to what service they're asking for (e.g., "full service", "MOT", "oil change")\n`;
    prompt += `- Get their vehicle registration\n`;
    prompt += `- Call gh_initiate_booking → then IMMEDIATELY call gh_get_services\n\n`;

    prompt += `**Step 2: Match & Quote**\n`;
    prompt += `- After gh_get_services returns, MATCH their request to the service list:\n`;
    prompt += `  • "full service" → find service with "Full Service" in name\n`;
    prompt += `  • "MOT" → find service with "MOT" in name\n`;
    prompt += `  • "oil change" → find service with "Oil" or "Filter"\n`;
    prompt += `  • "interim service" → find service with "Interim"\n`;
    prompt += `- If ONE match found → Quote the service naturally with description and price\n`;
    prompt += `- If MULTIPLE matches → Ask which one they mean\n`;
    prompt += `- If NO match (repairs, custom work) → Say you'll get them a callback quote\n`;
    prompt += `- DON'T show all services as a numbered list - be intelligent!\n\n`;

    prompt += `**Step 3: Confirm & Book**\n`;
    prompt += `- Ask "Would you like to book that in?"\n`;
    prompt += `- If YES → Call gh_set_service with the matched service ID\n`;
    prompt += `- Then IMMEDIATELY call gh_get_additional_services\n`;
    prompt += `- If extras available, mention them briefly\n`;
    prompt += `- Either way, IMMEDIATELY call gh_list_timeslots\n\n`;

    prompt += `**Step 4: Choose Time**\n`;
    prompt += `- Show available times from gh_list_timeslots\n`;
    prompt += `- When they pick a time → call gh_set_timeslot\n`;
    prompt += `- Get their contact info → call gh_set_contact_info\n`;
    prompt += `- Booking complete!\n\n`;

    prompt += `⚠️ CRITICAL RULES:\n`;
    prompt += `- After gh_initiate_booking succeeds → IMMEDIATELY call gh_get_services\n`;
    prompt += `- After gh_set_service succeeds → IMMEDIATELY call gh_get_additional_services\n`;
    prompt += `- After extras step → IMMEDIATELY call gh_list_timeslots\n`;
    prompt += `- "No thanks" to extras means CONTINUE TO TIMESLOTS, not end chat!\n`;
    prompt += `- Match services intelligently - don't dump all options on user\n\n`;

    // Add active session state if available
    if (activeSession && activeSession.session_id) {
      prompt += `🔥 ACTIVE BOOKING IN PROGRESS:\n`;
      prompt += `- Session: ${activeSession.session_id}\n`;
      prompt += `- Vehicle: ${activeSession.registration}\n`;
      prompt += `- STATUS: Booking already started!\n`;
      prompt += `- DO NOT call gh_initiate_booking - already done!\n`;

      if (activeSession.awaitingServiceSelection) {
        prompt += `\n⚠️ WAITING FOR SERVICE SELECTION:\n`;
        prompt += `- Services were just shown to the customer\n`;
        prompt += `- If their message is a NUMBER (1, 2, 3, etc.), they are selecting a service\n`;
        prompt += `- IMMEDIATELY call gh_set_service with that number\n`;
        prompt += `- Example: User says "5" → call gh_set_service({ service_id: "5" })\n\n`;
      } else {
        prompt += `- Next: Either show services (gh_get_services) OR continue booking flow\n\n`;
      }
    }
  } else {
    prompt += `\nFor bookings, please give them the phone number${config.phoneNumber ? ` (${config.phoneNumber})` : ''} or suggest they visit the website${config.websiteUrl ? ` at ${config.websiteUrl}` : ''}.\n\n`;
  }

  prompt += `HOW TO CHAT:\n`;
  prompt += `- Chat like a real person - warm, natural, and helpful\n`;
  prompt += `- Keep it brief (1-2 sentences) unless they need more detail\n`;
  prompt += `- Use everyday language, not corporate speak\n`;
  prompt += `- If you're not sure about something, be honest - don't make stuff up\n`;
  prompt += `- Use emojis occasionally to keep it friendly 😊\n`;
  prompt += `- If they're frustrated, acknowledge it and help however you can\n`;
  prompt += `- Ask follow-up questions if you need more info\n\n`;

  prompt += `Remember: You're a helpful human receptionist, not a robot. Be yourself!\n`;

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
