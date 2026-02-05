import { prisma } from '../db.js';
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

interface ChatAgentResponse {
  content: string;
  needsHumanAssistance?: boolean;
}

export async function getChatAgentResponse(
  garageId: string,
  message: string,
  conversationId: string
): Promise<ChatAgentResponse> {
  try {
    // Get garage configuration and knowledge base
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

    // Check if garage is currently open
    const isOpen = checkOpeningHours(config.weeklyOpeningHours);

    // Build conversation context from previous messages
    const previousMessages = await prisma.chatMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
      take: 10,
    });

    // Build system prompt
    const systemPrompt = buildSystemPrompt(config, garage.knowledgeDocuments, isOpen);

    // Build message history for OpenAI
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
    ];

    // Add previous messages (limit to last 10 for context)
    for (const msg of previousMessages) {
      messages.push({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: msg.content,
      });
    }

    // Add current message
    messages.push({ role: 'user', content: message });

    // Call OpenAI GPT-4o
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages,
      temperature: 0.7,
      max_tokens: 500,
    });

    const response = completion.choices[0]?.message?.content || 'I apologize, but I am unable to respond at this time. Please try again later.';

    return {
      content: response,
      needsHumanAssistance: false,
    };
  } catch (error) {
    console.error('Chat agent error:', error);
    throw error;
  }
}

function buildSystemPrompt(
  config: any,
  knowledgeDocuments: any[],
  isOpen: boolean
): string {
  const branchName = config.branchName || 'our garage';
  const phoneNumber = config.phoneNumber || '';
  const emailAddress = config.emailAddress || '';
  const websiteUrl = config.websiteUrl || '';
  const branchAddress = config.branchAddress || '';

  let prompt = `You are Leah, a helpful and friendly AI assistant for ${branchName}, a car repair and service garage. `;

  if (config.greetingLine) {
    prompt += `${config.greetingLine}\n\n`;
  }

  prompt += `Your role is to assist customers with inquiries, provide information about services, and help with booking appointments.\n\n`;

  // Business information
  prompt += `BUSINESS INFORMATION:\n`;
  prompt += `- Branch: ${branchName}\n`;
  if (branchAddress) prompt += `- Address: ${branchAddress}\n`;
  if (phoneNumber) prompt += `- Phone: ${phoneNumber}\n`;
  if (emailAddress) prompt += `- Email: ${emailAddress}\n`;
  if (websiteUrl) prompt += `- Website: ${websiteUrl}\n`;
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

  // Current status
  prompt += `CURRENT STATUS: The garage is currently ${isOpen ? 'OPEN' : 'CLOSED'}.\n\n`;

  // Knowledge base
  if (knowledgeDocuments.length > 0) {
    prompt += `KNOWLEDGE BASE:\n`;
    for (const doc of knowledgeDocuments) {
      if (doc.title) prompt += `${doc.title}:\n`;
      prompt += `${doc.content}\n\n`;
    }
  }

  // Tone preference
  const toneMap: Record<string, string> = {
    professional: 'Be professional and formal in your responses.',
    friendly: 'Be warm, friendly, and conversational.',
    standard: 'Be helpful and professional with a friendly tone.',
  };
  prompt += `\nTONE: ${toneMap[config.tonePreference] || toneMap.standard}\n`;

  // Instructions
  prompt += `\nINSTRUCTIONS:\n`;
  prompt += `- Keep responses concise and clear (max 2-3 sentences unless more detail is needed)\n`;
  prompt += `- If asked about booking appointments, provide the phone number or suggest they visit the website\n`;
  prompt += `- If you don't know something, be honest and offer to have someone call them back\n`;
  prompt += `- Never make up information about services, pricing, or availability\n`;
  prompt += `- Be empathetic and understanding about car troubles\n`;

  if (!isOpen) {
    prompt += `- Since we're currently closed, let customers know when we'll reopen and offer to take their details for a callback\n`;
  }

  return prompt;
}

function checkOpeningHours(weeklyOpeningHours: any): boolean {
  if (!weeklyOpeningHours || typeof weeklyOpeningHours !== 'object') {
    return true; // Default to open if no hours configured
  }

  const now = new Date();
  const currentDay = now.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
  const currentTime = now.toTimeString().slice(0, 5); // HH:MM format

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
