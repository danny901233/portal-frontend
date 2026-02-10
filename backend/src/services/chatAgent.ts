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
    if (config.integrationProviderConfig && typeof config.integrationProviderConfig === 'object') {
      const ghConfig = config.integrationProviderConfig as any;
      GH_CUSTOMER_ID = ghConfig.ghCustomerId || ghConfig.customerId;
      GH_API_KEY = ghConfig.ghApiKey || ghConfig.apiKey;
      GH_LOCATION_ID = ghConfig.ghLocationId || ghConfig.locationId || '23';
    }

    // Build conversation context
    const previousMessages = await prisma.chatMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
      take: 10,
    });

    const systemPrompt = buildSystemPrompt(config, garage.knowledgeDocuments, isOpen);

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
    let response = await getOpenAI().chat.completions.create({
      model: 'gpt-4o',
      messages,
      temperature: 0.7,
      max_tokens: 500,
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
        temperature: 0.7,
        max_tokens: 500,
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
        description: 'Get the list of available services for booking. Call this after initiating a booking.',
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
        description: 'Select a service for the booking.',
        parameters: {
          type: 'object',
          properties: {
            service_id: {
              type: 'string',
              description: 'The ID of the service to book',
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
        description: 'Get available appointment times after selecting a service.',
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
        return await ghGetServices(sessionData.session_id);

      case 'gh_set_service':
        if (!sessionData.session_id) {
          return { error: 'No active booking session' };
        }
        return await ghSetService(sessionData.session_id, args.service_id);

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

  try {
    // Step 1: Init booking
    const initResp = await axios.post(
      `https://onlinebooking.garagehive.co.uk/api/external-booking/${instance}/init`,
      { locationId },
      { headers, timeout: 20000 }
    );

    const sessionId = initResp.data.booking?.session_id || initResp.data.sessionId;

    if (!sessionId) {
      return { error: 'Failed to create booking session' };
    }

    // Step 2: Set vehicle info
    const vehicleResp = await axios.post(
      `https://onlinebooking.garagehive.co.uk/api/external-booking/${instance}/${sessionId}/set-vehicle-info`,
      {
        registration_no: registration.toUpperCase().replace(/\s+/g, ''),
        reg_no_country: 'GB',
        location_id: locationId,
      },
      { headers, timeout: 20000 }
    );

    // Store session
    bookingSessions.set(conversationId, {
      session_id: sessionId,
      registration,
    });

    return {
      success: true,
      session_id: sessionId,
      vehicle: vehicleResp.data.vehicle || vehicleResp.data,
    };
  } catch (error: any) {
    console.error('[GH_INITIATE_BOOKING] Error:', error.response?.data || error.message);
    return { error: 'Failed to initiate booking. Please try again.' };
  }
}

async function ghGetServices(sessionId: string): Promise<any> {
  const instance = GH_CUSTOMER_ID;
  const headers: any = { 'Content-Type': 'application/json' };
  if (GH_API_KEY) headers['Authorization'] = `Bearer ${GH_API_KEY}`;

  try {
    const resp = await axios.get(
      `https://onlinebooking.garagehive.co.uk/api/external-booking/${instance}/${sessionId}/list-services`,
      { headers, timeout: 20000 }
    );
    return resp.data;
  } catch (error: any) {
    return { error: 'Failed to get services' };
  }
}

async function ghSetService(sessionId: string, serviceId: string): Promise<any> {
  const instance = GH_CUSTOMER_ID;
  const headers: any = { 'Content-Type': 'application/json' };
  if (GH_API_KEY) headers['Authorization'] = `Bearer ${GH_API_KEY}`;

  try {
    const resp = await axios.post(
      `https://onlinebooking.garagehive.co.uk/api/external-booking/${instance}/${sessionId}/set-service`,
      { service_id: serviceId },
      { headers, timeout: 20000 }
    );
    return resp.data;
  } catch (error: any) {
    return { error: 'Failed to set service' };
  }
}

async function ghListTimeslots(sessionId: string): Promise<any> {
  const instance = GH_CUSTOMER_ID;
  const headers: any = { 'Content-Type': 'application/json' };
  if (GH_API_KEY) headers['Authorization'] = `Bearer ${GH_API_KEY}`;

  try {
    const resp = await axios.get(
      `https://onlinebooking.garagehive.co.uk/api/external-booking/${instance}/${sessionId}/list-timeslots`,
      { headers, timeout: 20000 }
    );
    return resp.data;
  } catch (error: any) {
    return { error: 'Failed to get available times' };
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
    return { error: 'Failed to book time slot' };
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
    return { error: 'Failed to save contact information' };
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

function buildSystemPrompt(config: any, knowledgeDocuments: any[], isOpen: boolean): string {
  const branchName = config.branchName || 'our garage';

  let prompt = `You are Leah, a helpful AI assistant for ${branchName}, a car repair and service garage. `;

  if (config.greetingLine) {
    prompt += `${config.greetingLine}\n\n`;
  }

  prompt += `You can help customers book appointments directly through this chat using our booking system.\n\n`;

  // Business info
  prompt += `BUSINESS INFORMATION:\n`;
  prompt += `- Branch: ${branchName}\n`;
  if (config.branchAddress) prompt += `- Address: ${config.branchAddress}\n`;
  if (config.phoneNumber) prompt += `- Phone: ${config.phoneNumber}\n`;
  if (config.emailAddress) prompt += `- Email: ${config.emailAddress}\n`;
  if (config.websiteUrl) prompt += `- Website: ${config.websiteUrl}\n`;
  prompt += `\n`;

  // Opening hours
  if (config.weeklyOpeningHours) {
    prompt += `OPENING HOURS:\n`;
    const hours = config.weeklyOpeningHours as Record<string, any>;
    for (const [day, times] of Object.entries(hours)) {
      if (times && typeof times === 'object' && 'open' in times && 'close' in times) {
        prompt += `- ${day}: ${times.open} - ${times.close}\n`;
      }
    }
    prompt += `\n`;
  }

  prompt += `CURRENT STATUS: ${isOpen ? 'OPEN' : 'CLOSED'}\n\n`;

  // Knowledge base
  if (knowledgeDocuments.length > 0) {
    prompt += `KNOWLEDGE BASE:\n`;
    for (const doc of knowledgeDocuments) {
      if (doc.title) prompt += `${doc.title}:\n`;
      prompt += `${doc.content}\n\n`;
    }
  }

  // Booking instructions
  prompt += `\nBOOKING INSTRUCTIONS:\n`;
  prompt += `- You have access to booking tools to help customers book appointments\n`;
  prompt += `- To start a booking, ask for their vehicle registration number\n`;
  prompt += `- Then use gh_initiate_booking with their registration\n`;
  prompt += `- Guide them through selecting a service, choosing a time, and confirming details\n`;
  prompt += `- If they prefer, you can send them a booking link via SMS using send_booking_link_sms\n`;
  prompt += `- Keep the booking process smooth and conversational\n`;
  prompt += `- Always confirm the details before finalizing\n\n`;

  prompt += `TONE: Be friendly, helpful, and professional. Keep responses concise (2-3 sentences unless more detail is needed).\n`;

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
