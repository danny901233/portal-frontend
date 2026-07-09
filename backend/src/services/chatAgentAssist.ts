import { prisma } from '../db.js';
import { notifyMessaging } from './messagingNotifications.js';
import OpenAI from 'openai';
import { logChatToolCall } from './chatToolLog.js';
import { imageMessageContent } from './chatMedia.js';

// ── Assist chat agent ───────────────────────────────────────────────────────
// The chat counterpart of the optimised-assist VOICE agent: message-taking, plus SYNTHETIC-slot
// "bookings" when the garage has bookings enabled (no real diary — the team confirms). It has NO
// GarageHive / Tyresoft integration. Routed to by chatAgentRouter for agentType === 'assist'.
// Forked from the structure of chatAgentTyresoft (same response-loop + tool-call contract); the
// route layer persists chat messages, so this just returns { content }.

interface ChatAgentResponse {
  content: string;
  needsHumanAssistance?: boolean;
}

interface AssistSession {
  customerName?: string;
}

let openaiClient: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!openaiClient) {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured');
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openaiClient;
}

const assistSessions = new Map<string, AssistSession>();

// Mon–Fri 8am–4pm hourly slots, starting today + leadDays. Mirrors the voice agent's
// generate_synthetic_slots so chat offers the same provisional availability.
function generateSyntheticSlots(leadDays: number, weeks = 4): { date: string; time: string }[] {
  const slots: { date: string; time: string }[] = [];
  const start = new Date();
  start.setDate(start.getDate() + Math.max(0, leadDays || 0));
  const end = new Date(start);
  end.setDate(end.getDate() + weeks * 7);
  for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const day = d.getDay(); // 0 Sun … 6 Sat
    if (day === 0 || day === 6) continue;
    for (let h = 8; h <= 16; h++) {
      slots.push({ date: d.toISOString().slice(0, 10), time: `${String(h).padStart(2, '0')}:00` });
    }
  }
  return slots;
}

function checkOpeningHours(weeklyOpeningHours: any): boolean {
  if (!weeklyOpeningHours || typeof weeklyOpeningHours !== 'object') return true;
  const now = new Date();
  const day = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][now.getDay()];
  const today = (weeklyOpeningHours as Record<string, any>)[day];
  if (!today || typeof today !== 'object' || !today.open || !today.close) return false;
  const [oh, om] = String(today.open).split(':').map(Number);
  const [ch, cm] = String(today.close).split(':').map(Number);
  const mins = now.getHours() * 60 + now.getMinutes();
  return mins >= oh * 60 + (om || 0) && mins < ch * 60 + (cm || 0);
}

function buildAssistTools(allowBookings: boolean, humanEscalation: boolean): OpenAI.Chat.ChatCompletionTool[] {
  const tools: OpenAI.Chat.ChatCompletionTool[] = [
    {
      type: 'function',
      function: {
        name: 'save_caller_name',
        description: "Save the customer's name the moment they give it. Call this early.",
        parameters: {
          type: 'object',
          properties: {
            first_name: { type: 'string' },
            last_name: { type: 'string' },
          },
          required: ['first_name'],
        },
      },
    },
  ];
  // take_message only exists when human escalation is enabled. With it off there is no one to follow
  // up over chat, so the agent must point the customer at the garage's phone/email instead.
  if (humanEscalation) {
    tools.push({
      type: 'function',
      function: {
        name: 'take_message',
        description:
          'Hand the customer to a human. ONLY call this when EITHER (a) you genuinely cannot help from your knowledge or tools, OR (b) the customer explicitly asks to speak to a human / for someone to call them back. Do NOT call it for questions you can answer or bookings you can make yourself — help with those directly. When you do use it, first gather their name, best contact number, the vehicle registration (if it concerns a specific car), exactly what they need (the specific job/symptom — not just "a booking"), and any preferred timing, then make the reason detailed.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            phone: { type: 'string', description: 'Best contact number' },
            reason: { type: 'string', description: "What they need — be specific: the job/symptom, the vehicle reg & make/model if given, and any preferred day/time" },
            vehicle_registration: { type: 'string', description: "Reg if it's about a specific vehicle, else omit" },
          },
          required: ['name', 'phone', 'reason'],
        },
      },
    });
  }
  if (allowBookings) {
    tools.push({
      type: 'function',
      function: {
        name: 'book_slot',
        description:
          'Provisionally book the customer into a slot they chose from the offered availability. The team confirms it afterwards. Only call this AFTER the customer has picked a specific date and time and you have their name + phone.',
        parameters: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'YYYY-MM-DD of the chosen slot' },
            time: { type: 'string', description: 'HH:MM of the chosen slot' },
            name: { type: 'string' },
            phone: { type: 'string' },
            reason: { type: 'string', description: 'What the booking is for (service/MOT/etc.)' },
            vehicle_registration: { type: 'string' },
          },
          required: ['date', 'time', 'name', 'phone', 'reason'],
        },
      },
    });
  }
  return tools;
}

async function executeAssistTool(
  name: string,
  args: any,
  conversationId: string,
  session: AssistSession,
): Promise<any> {
  try {
    switch (name) {
      case 'save_caller_name': {
        const full = `${String(args.first_name || '').trim()} ${String(args.last_name || '').trim()}`.trim();
        if (!full) return { error: 'No name provided. Ask the customer for their name.' };
        session.customerName = full;
        return { success: true, message: `Saved name: ${full}. Continue — do not acknowledge this.` };
      }
      case 'take_message':
      case 'book_slot': {
        // Both hand the conversation to the team (Assist has no real diary). The full details
        // (name, phone, reason, chosen slot) live in the chat transcript the team reads.
        if (conversationId) {
          await prisma.chatConversation.updateMany({
            where: { id: conversationId },
            data: { needsAttention: true, agentPaused: true },
          });
          void notifyMessaging({ conversationId, event: 'escalated' });
        }
        if (name === 'book_slot') {
          return {
            success: true,
            message: `Provisional booking noted for ${args.date} at ${args.time}. Tell the customer it's provisional and the team will confirm shortly.`,
          };
        }
        return { success: true, message: 'Message taken. The team has been notified and will get back to you shortly.' };
      }
      default:
        return { error: 'Unknown tool' };
    }
  } catch (error: any) {
    console.error(`[ASSIST_CHAT] Tool error (${name}):`, error.message);
    return { error: error.message || 'Tool execution failed' };
  }
}

function buildAssistSystemPrompt(
  config: any,
  knowledgeDocs: any[],
  isOpen: boolean,
  allowBookings: boolean,
  slots: { date: string; time: string }[],
  humanEscalation: boolean,
): string {
  const branchName = config.branchName || 'our garage';
  const agentName = (config.agentName || '').trim() || 'Leah';
  let prompt = `You are ${agentName}, the friendly AI receptionist for ${branchName}, a UK car garage. ${config.greetingLine || ''}\n\n`;

  prompt += `You are warm, natural and concise — British English (tyre, bonnet, MOT). Never use lists or bullet points in chat. One question at a time.\n\n`;

  prompt += `About us:\n`;
  if (config.branchAddress) prompt += `Address: ${config.branchAddress}\n`;
  if (config.phoneNumber) prompt += `Phone: ${config.phoneNumber}\n`;
  if (config.emailAddress) prompt += `Email: ${config.emailAddress}\n`;
  if (config.weeklyOpeningHours) {
    const hours = config.weeklyOpeningHours as Record<string, any>;
    const lines: string[] = [];
    for (const [day, t] of Object.entries(hours)) {
      if (t && typeof t === 'object' && (t as any).open && (t as any).close) {
        lines.push(`${day.charAt(0).toUpperCase() + day.slice(1)}: ${(t as any).open}–${(t as any).close}`);
      }
    }
    if (lines.length) prompt += `Opening hours: ${lines.join(', ')}\n`;
  }
  prompt += '\n';

  // Knowledge base (website scan, uploaded documents, price lists).
  const priceListDocs = (knowledgeDocs || []).filter((d) => d.source === 'price-list');
  if (knowledgeDocs && knowledgeDocs.length) {
    prompt += `Reference information about this garage — answer ONLY from this, never invent:\n`;
    for (const doc of knowledgeDocs) {
      if (doc.title) prompt += `${doc.title}:\n`;
      prompt += `${doc.content}\n\n`;
    }
  }

  // ── Per-garage config: custom rules, FAQs, smart questions (parity with the voice agents) ──
  const rules = Array.isArray(config.customRules)
    ? config.customRules
        .filter((r: any) => r && typeof r === 'object' && r.active === true && (r.text || '').trim())
        .map((r: any) => `- ${String(r.text).trim()}`)
    : [];
  if (rules.length > 0) {
    prompt += `RULES YOU MUST FOLLOW (these override anything else in this prompt):\n${rules.join('\n')}\n\n`;
  }
  const faqs = Array.isArray(config.faqs)
    ? config.faqs
        .filter((f: any) => f && (f.question || f.q) && (f.answer || f.a))
        .map((f: any) => `Q: ${String(f.question || f.q).trim()}\nA: ${String(f.answer || f.a).trim()}`)
    : [];
  if (faqs.length > 0) {
    prompt += `COMMON QUESTIONS — answer from these when a customer asks something similar; do NOT invent an answer:\n${faqs.join('\n')}\n\n`;
  }
  const fields = Array.isArray(config.dataCollectionFields)
    ? config.dataCollectionFields
        .filter((f: any) => f && f.active === true && (f.label || f.key))
        .map((f: any) => {
          const label = String(f.label || f.key).trim();
          const tag = f.required ? '(required)' : '(only if relevant)';
          const instr = (f.instruction || '').trim() ? ` — ${String(f.instruction).trim()}` : '';
          return `- ${label} ${tag}${instr}`;
        })
    : [];
  if (fields.length > 0) {
    prompt += `INFORMATION TO COLLECT during the chat (ask naturally, one at a time):\n${fields.join('\n')}\n\n`;
  }

  // ── Prices ──
  if (priceListDocs.length > 0) {
    prompt += `PRICES: this garage has uploaded a price list (above). You MAY quote a price, but ONLY the exact figure from that price list — never invent, estimate, or round. If it isn't in the price list, say you can't give a price and offer to take the customer's details for a callback.\n\n`;
  } else {
    prompt += `PRICES: you do NOT have prices. Never guess or invent one. If asked, offer to take their details and have the team call back with a quote.\n\n`;
  }

  // ── What this agent can do ──
  prompt += `WHAT YOU DO:\n`;
  prompt += `- Answer questions about the garage from the information above.\n`;
  if (allowBookings) {
    const preview = slots.slice(0, 12).map((s) => `${s.date} at ${s.time}`).join(', ');
    prompt += `- BOOKINGS ARE ENABLED. You can offer the customer a provisional appointment. When they want to book, get what they need done, then offer 2–3 of these available slots (don't list them all): ${preview}. When they pick one, get their name + phone + the vehicle reg, then call book_slot. Tell them it's provisional and the team will confirm.\n`;
  }
  if (humanEscalation) {
    if (!allowBookings) {
      prompt += `- You can't access a diary, but you CAN take a message so the team calls them back to book or help.\n`;
    }
    prompt += `- WHEN TO HAND OVER: only take a message / involve a human when EITHER you genuinely can't help from the information and tools you have, OR the customer explicitly asks to speak to a human or for a callback. If you can answer their question${allowBookings ? ' or book them in' : ''} yourself, just do it — don't take a message.\n`;
    prompt += `- WHEN you do take a message, GATHER THE FULL PICTURE first — never fire it off with just a name and "a booking". Ask, naturally and one at a time, for: their name, best contact number, the vehicle registration (if it's about a specific car), exactly what they need (the specific job, MOT, service, or the symptom/noise — get the detail), and roughly when would suit them. THEN call take_message with a detailed reason.\n`;
  } else {
    const custom = ((config as any).messagingHandoffMessage || '').trim();
    if (custom) {
      prompt += `- IMPORTANT: no one is available to follow up over chat. When the customer asks to speak to a person, wants a callback, or needs anything you can't answer${allowBookings ? ' or book yourself' : ''}, do NOT offer to take a message — reply with this exact message: "${custom}"\n`;
    } else {
      const contact = [config.phoneNumber ? `phone ${config.phoneNumber}` : '', config.emailAddress ? `email ${config.emailAddress}` : ''].filter(Boolean).join(' or ');
      prompt += `- IMPORTANT: no one is available to follow up over chat and you CANNOT take messages or promise a callback. For anything you can't answer from the information above${allowBookings ? ' or book yourself' : ''} — a complaint, a status update, speaking to a person, ${allowBookings ? '' : 'a booking, '}or anything needing a human — do NOT offer to pass it on. Politely tell them to get in touch with the garage directly${contact ? ` on ${contact}` : ''}, as no one is available over chat.\n`;
    }
  }
  prompt += `\n`;

  prompt += `RULES:\n`;
  prompt += `- Save the customer's name early with save_caller_name.\n`;
  if (humanEscalation) {
    prompt += `- Never say "I'll pass that on" / "I've booked you in" before the matching tool has actually been called — the words alone do nothing.\n`;
  } else {
    prompt += `- Never offer to take a message, pass details on, or arrange a callback — you can't. Direct them to the garage's phone/email instead.\n`;
  }
  prompt += `- Keep replies to one or two sentences. Don't invent availability, prices, or details.\n`;
  prompt += `- We're currently ${isOpen ? 'open' : 'closed'} — only mention hours if asked.\n`;

  return prompt;
}

export async function getAssistChatResponse(
  garageId: string,
  message: string,
  conversationId: string,
  seedContact?: { phone?: string; name?: string },
): Promise<ChatAgentResponse> {
  try {
    const garage = await prisma.garage.findUnique({
      where: { id: garageId },
      include: {
        agentConfiguration: true,
        knowledgeDocuments: { orderBy: { updatedAt: 'desc' }, take: 10 },
      },
    });
    if (!garage?.agentConfiguration) throw new Error('Garage configuration not found');
    const config = garage.agentConfiguration;

    const allowBookings = config.allowBookings === true;
    // Chat-specific handoff (independent of the voice humanEscalation). Default ON.
    const messagingHandoff = (config as any).messagingHumanHandoff !== false;
    const leadDays = Number(config.bookingLeadTimeDays ?? 1) || 1;
    const slots = allowBookings ? generateSyntheticSlots(leadDays) : [];
    const isOpen = checkOpeningHours(config.weeklyOpeningHours);

    const session = assistSessions.get(conversationId) || {};
    assistSessions.set(conversationId, session);

    const tools = buildAssistTools(allowBookings, messagingHandoff);
    const sysPrompt = buildAssistSystemPrompt(config, garage.knowledgeDocuments, isOpen, allowBookings, slots, messagingHandoff);

    const previousMessages = (
      await prisma.chatMessage.findMany({
        where: { conversationId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      })
    ).reverse();

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: 'system', content: sysPrompt }];
    const total = previousMessages.length;
    for (let i = 0; i < total; i++) {
      const msg = previousMessages[i];
      const role = msg.role === 'user' ? 'user' : 'assistant';
      // Pass recent customer image attachments to the (vision-capable gpt-4o) model.
      if (role === 'user' && i >= total - 4) {
        const imgContent = await imageMessageContent(msg);
        if (imgContent) { messages.push({ role: 'user', content: imgContent }); continue; }
      }
      messages.push({ role, content: msg.content });
    }

    let userContent = message;
    if (seedContact && previousMessages.length === 0) {
      const hints: string[] = [];
      if (seedContact.name) hints.push(`[Customer name: ${seedContact.name}]`);
      if (seedContact.phone) hints.push(`[Customer phone: ${seedContact.phone}]`);
      if (hints.length) userContent = `${hints.join(' ')} ${message}`;
    }
    // Don't re-append the current turn as a bare image placeholder — the loop already attached it.
    const lastPrev = previousMessages[previousMessages.length - 1];
    const curIsImgPlaceholder = ['[Customer sent an image]', '[Image]'].includes(message);
    const lastPrevIsImg = lastPrev?.role === 'user' && !!lastPrev?.mediaType?.startsWith('image/');
    if (!(curIsImgPlaceholder && lastPrevIsImg)) {
      messages.push({ role: 'user', content: userContent });
    }

    let response = await getOpenAI().chat.completions.create({
      model: 'gpt-4o',
      messages,
      temperature: 0.7,
      max_tokens: 250,
      tools,
      tool_choice: 'auto',
    });

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
          args = {};
        }
        console.log(`[ASSIST_CHAT] Tool call: ${call.function.name}`, args);
        const _t0 = Date.now();
        const result = await executeAssistTool(call.function.name, args, conversationId, session);
        logChatToolCall({ conversationId, garageId, agentType: 'assist', toolName: call.function.name, args, result, durationMs: Date.now() - _t0 });
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }
      response = await getOpenAI().chat.completions.create({
        model: 'gpt-4o',
        messages,
        temperature: 0.7,
        max_tokens: 250,
        tools,
        tool_choice: 'auto',
      });
    }

    const content =
      response.choices[0]?.message?.content ||
      "Sorry, I'm unable to respond right now. Please try again or call us directly.";
    return { content, needsHumanAssistance: false };
  } catch (error: any) {
    console.error('[ASSIST_CHAT] Error:', error.message);
    return {
      content: "Sorry, something went wrong on my end. Please try again, or give us a call.",
      needsHumanAssistance: false,
    };
  }
}
