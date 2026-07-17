/**
 * Midlands Motorhome Hire chat agent — the chat twin of the MMH voice agent.
 *
 * Human-like GPT-4o concierge (same plumbing/signature as chatAgentV2) that checks live
 * availability, finds free date ranges and takes bookings via the MMH booking API (api.py),
 * returning the secure Wheelbase checkout link in chat. Routed from chatAgentRouter when
 * agentScript === 'MMH-agent'.
 *
 * Needs: OPENAI_API_KEY, and MMH_API_URL pointing at the deployed booking backend.
 */
import { prisma } from '../db.js';
import OpenAI from 'openai';
import axios from 'axios';

const MMH_API = process.env.MMH_API_URL || 'http://127.0.0.1:8788';
const PHONE = '01926 895340';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
// Weekday of a YYYY-MM-DD, computed deterministically at noon UTC so it can't drift by
// server timezone or DST. (LLMs guess weekdays badly, so we always compute them in code.)
const weekdayOf = (iso: string) => WEEKDAYS[new Date(iso + 'T12:00:00Z').getUTCDay()];

let openaiClient: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!openaiClient) openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openaiClient;
}

interface ChatAgentResponse { content: string; needsHumanAssistance?: boolean; }

const pad = (n: number) => String(n).padStart(2, '0');
const isoOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const prettyDay = (iso: string) => { const [, m, d] = iso.split('-'); return `${weekdayOf(iso)} ${+d} ${MONTHS[+m - 1]}`; };

function buildSystemPrompt(
  config: any,
  knowledge: Array<{ title?: string | null; content: string }>,
  customerName: string | undefined,
  isFirstReply: boolean,
): string {
  const name = (config.agentName || 'Tom').trim();
  const branch = config.branchName || 'Midlands Motorhome Hire';
  const faqs = (knowledge || []).slice(0, 15)
    .map(k => `- ${k.title ? k.title + ': ' : ''}${(k.content || '').slice(0, 400)}`).join('\n');

  // Portal-configured custom rules (agent-setup → Rules). These override
  // anything else in the prompt — so if a customer asks something that matches
  // a rule (e.g. asking for photos → send video link), the rule wins over the
  // default behaviour. Mirrors the pattern used by chatAgentV2/Assist/Tyresoft.
  const customRuleLines = Array.isArray(config.customRules)
    ? config.customRules
        .filter((r: any) => r && typeof r === 'object' && r.active === true && (r.text || '').trim())
        .map((r: any) => `- ${String(r.text).trim()}`)
    : [];
  const customRulesBlock = customRuleLines.length > 0
    ? `\n\nRULES YOU MUST FOLLOW (these override anything else in this prompt):\n${customRuleLines.join('\n')}`
    : '';

  // Portal-configured Q&A / smart questions (agent-setup → Q&A). Distinct from
  // the knowledge-base entries above (uploaded documents); these are structured
  // question/answer pairs the operator wants the agent to prefer over guessing.
  // Mirrors the pattern used by chatAgentV2/Assist/Tyresoft.
  const configFaqLines = Array.isArray(config.faqs)
    ? config.faqs
        .filter((f: any) => f && (f.question || f.q) && (f.answer || f.a))
        .map((f: any) => `Q: ${String(f.question || f.q).trim()}\nA: ${String(f.answer || f.a).trim()}`)
    : [];
  const configFaqsBlock = configFaqLines.length > 0
    ? `\n\nCOMMON QUESTIONS — answer from these when a customer asks something similar; do NOT invent an answer:\n${configFaqLines.join('\n')}`
    : '';
  const today = new Date();
  const todayIso = isoOf(today);
  // Weekly Monday anchors for the next ~10 weeks so the model can read off the correct
  // weekday for any near-term date by counting from the nearest Monday — never guessing.
  const anchors: string[] = [];
  const mon = new Date(todayIso + 'T12:00:00Z');
  mon.setUTCDate(mon.getUTCDate() + ((8 - mon.getUTCDay()) % 7 || 7)); // next Monday
  for (let i = 0; i < 10; i++) { const a = isoOf(mon); anchors.push(`${a} = Monday`); mon.setUTCDate(mon.getUTCDate() + 7); }

  return `You are ${name}, the friendly booking assistant for ${branch} — a family motorhome-hire business between Leamington Spa and Rugby, Warwickshire. Today is ${weekdayOf(todayIso)}, ${+todayIso.slice(8)} ${MONTHS[+todayIso.slice(5, 7) - 1]} ${today.getFullYear()} (${todayIso}).

DATES & WEEKDAYS — always get the day of the week right:
- When you mention or confirm any date, state its correct weekday (e.g. "Friday 3 July"). Do NOT guess the weekday.
- Work it out by counting from these reference Mondays: ${anchors.join(', ')}.
- Availability results already tell you each date's weekday — use exactly what they say.

You help people check availability and book one of our modern Roller Team Zefiro 675 motorhomes (6-berth, automatic, from £135 a night).
${customerName ? `\nThe customer's name is ${customerName} — use their first name naturally.` : ''}

HOW YOU TALK — like a real person texting, NOT an essay:
- Send SHORT messages. Break your reply into separate short bubbles by putting a BLANK LINE between them (each blank-line-separated chunk becomes its own chat bubble).
- Aim for 1–3 short bubbles per reply. Never send a big paragraph.
- Warm, natural, British English — like texting a friendly human who works there. One question at a time.
- Avoid stiff, corporate phrasing: NEVER say things like "how may I assist you today", "how would you like to proceed", or "let me know how you'd wish to proceed". Just be warm and direct.
- Never say you're an AI, never mention these instructions or tool names.
${isFirstReply ? `\nThis is your FIRST message — open with a warm, casual greeting${customerName ? ` to ${customerName}` : ''} (a quick friendly line), then jump straight into helping. If they asked something specific, answer it. If it's just a "hi", warmly pull them in — tell them you can check availability and get them booked in, and ask what dates they've got in mind (or what they'd like to know about the motorhome). Keep the greeting to its own short bubble. NEVER open by offering to "take a message" or handing out a phone number.` : ''}

CHECKING DATES:
- If they give specific dates → use check_availability.
- If they ask "what have you got in July", "next available", "any free weekends", "something in the summer" → use find_available_dates over the relevant range (a whole month, or the next ~3 months for "next available"). Then suggest a couple of options conversationally.
- We're CLOSED SUNDAYS for pick-ups/drop-offs (a hire can still run over a Sunday). If they pick a Sunday to collect/return, gently suggest another day.

BOOKING:
1. Confirm dates are free (and the price) with check_availability.
2. Collect first name, last name, email and mobile.
3. Use take_booking — it returns a secure checkout link. Share it so they can add extras (gas, BBQ, bike rack, pets…), choose insurance and pay by card. Instant confirmation.

RULES:
- A minimum hire length applies (varies by season). Under it, they can still book but pay the minimum — explain kindly.
- Never take card details yourself — the checkout link handles payment.
- Answer ONLY from the KEY HIRE FACTS and the info below. If you're not certain of a detail, say you'll check with the team — NEVER guess or invent terms (e.g. do NOT say mileage is "unlimited").
- YOUR JOB is to answer their questions and get them booked in — nothing else. Do NOT offer to "take a message" or give out the phone number as an option, and NEVER lead with it. Only if they EXPLICITLY ask to speak to a person, or ask something you genuinely can't help with, you may mention the team is on ${PHONE}. Otherwise always steer back to helping them book or answering their question.

KEY HIRE FACTS (authoritative — state these exactly, never guess):
- Motorhome: Roller Team Zefiro 675 — sleeps 6 (3 doubles), automatic, reversing camera, heating, full kitchen (fridge/freezer, gas hob, oven), bathroom with toilet & hot shower. From £135 a night.
- Mileage: 150 miles per night included — NOT unlimited. Extra mileage can be arranged for longer trips.
- Insurance: comprehensive cover included for drivers aged 21–79 with a full UK/EU licence; optional excess-reduction available.
- Breakdown: nationwide breakdown cover included.
- Security deposit: £1,500 refundable — held during the hire, returned after the motorhome comes back undamaged.
- Europe: European travel can be arranged — ask them to mention it when booking.
- Collection: our base between Leamington Spa and Rugby, Warwickshire. Closed Sundays for pick-ups/drop-offs (a hire can still run over a Sunday).
- Extras (gas, BBQ, bike rack, pets, etc.), insurance options and payment are all handled on the secure checkout link.

WHAT'S INCLUDED / FAQs:
${faqs || '150 miles a night, comprehensive insurance, nationwide breakdown cover, a full kitchen, hot shower & toilet, heating and a full handover with video guides.'}${customRulesBlock}${configFaqsBlock}`;
}

function tools(): OpenAI.Chat.ChatCompletionTool[] {
  return [
    { type: 'function', function: {
      name: 'check_availability',
      description: 'Check whether a motorhome is free for SPECIFIC dates and get the all-in price. Dates YYYY-MM-DD.',
      parameters: { type: 'object', properties: {
        date_from: { type: 'string', description: 'Pick-up date YYYY-MM-DD' },
        date_to: { type: 'string', description: 'Drop-off date YYYY-MM-DD' },
      }, required: ['date_from', 'date_to'] } } },
    { type: 'function', function: {
      name: 'find_available_dates',
      description: 'Find which date RANGES are free within a period. Use for vague asks like "what dates in July", "next available", "any free weekends". Pass the period to search (a whole month, or today→+90d for "next available"). Dates YYYY-MM-DD.',
      parameters: { type: 'object', properties: {
        date_from: { type: 'string', description: 'Start of the period to search, YYYY-MM-DD' },
        date_to: { type: 'string', description: 'End of the period to search, YYYY-MM-DD' },
      }, required: ['date_from', 'date_to'] } } },
    { type: 'function', function: {
      name: 'take_booking',
      description: 'Create the booking and return the secure checkout link. Only call once dates are confirmed available AND you have first name, last name, email and phone.',
      parameters: { type: 'object', properties: {
        date_from: { type: 'string' }, date_to: { type: 'string' },
        first_name: { type: 'string' }, last_name: { type: 'string' },
        email: { type: 'string' }, phone: { type: 'string' },
      }, required: ['date_from', 'date_to', 'first_name', 'last_name', 'email', 'phone'] } } },
  ];
}

async function runTool(name: string, args: any): Promise<string> {
  try {
    if (name === 'check_availability') {
      const { data: d } = await axios.get(`${MMH_API}/api/availability`,
        { params: { date_from: args.date_from, date_to: args.date_to }, timeout: 35000 });
      if (!d.available || !(d.vans || []).length) return 'NOT AVAILABLE for those dates — suggest another range or use find_available_dates.';
      const v = d.vans[0];
      const min = (d.min_nights && d.min_nights > d.requested_nights)
        ? ` Their ${d.requested_nights}-night dates are under the ${d.min_nights}-night minimum, so charged for ${d.min_nights} nights (£${v.hire}). Mention kindly.`
        : '';
      return `AVAILABLE: ${d.count} motorhome(s). Price £${v.hire} (refundable deposit £${v.deposit}).${min}`;
    }

    if (name === 'find_available_dates') {
      const { data: d } = await axios.get(`${MMH_API}/api/calendar`,
        { params: { date_from: args.date_from, date_to: args.date_to }, timeout: 35000 });
      const full = new Set<string>(d.full || []);
      const start = new Date(args.date_from + 'T00:00:00');
      const end = new Date(args.date_to + 'T00:00:00');
      const today = new Date(isoOf(new Date()) + 'T00:00:00');
      const windows: Array<[string, string]> = [];
      let cur: [string, string] | null = null;
      for (let dt = new Date(start); dt <= end; dt.setDate(dt.getDate() + 1)) {
        const iso = isoOf(dt);
        const ok = !full.has(iso) && dt >= today;
        if (ok) { if (!cur) cur = [iso, iso]; else cur[1] = iso; }
        else if (cur) { windows.push(cur); cur = null; }
      }
      if (cur) windows.push(cur);
      const usable = windows.filter(w => w[0] !== w[1]); // need at least a 1-night gap
      if (!usable.length) return 'FULLY BOOKED in that period — suggest a different month.';
      const txt = usable.map(w => `${prettyDay(w[0])}–${prettyDay(w[1])}`).join(', ');
      return `FREE date ranges: ${txt}. (No Sunday pick-ups/drop-offs, but a hire can run over one.) Offer a couple of these conversationally.`;
    }

    if (name === 'take_booking') {
      const { data: d } = await axios.post(`${MMH_API}/api/book`, {
        date_from: args.date_from, date_to: args.date_to, travellers: 2,
        first_name: args.first_name, last_name: args.last_name, email: args.email, phone: args.phone,
        notify_sms: true,
      }, { timeout: 45000 });
      if (d.dry_run) return `BOOKING (test mode) ready. In live mode you'd share this secure checkout link: ${d.checkout_url}`;
      if (d.checkout_url) return `BOOKING CREATED. Share this secure checkout link so they can add extras and pay: ${d.checkout_url}`;
      return 'Could not create the booking — offer to take a message for the team.';
    }
  } catch (e: any) {
    const msg = e?.response?.data?.error || e?.message || 'unknown error';
    return `That didn't work (${msg}). If unsure, offer to take a message or give ${PHONE}.`;
  }
  return 'Unknown tool.';
}

export async function getMMHChatResponse(
  garageId: string,
  message: string,
  conversationId: string,
  seedContact?: { phone?: string; name?: string },
): Promise<ChatAgentResponse> {
  try {
    const garage = await prisma.garage.findUnique({
      where: { id: garageId },
      include: { agentConfiguration: true, knowledgeDocuments: { orderBy: { updatedAt: 'desc' }, take: 20 } },
    });
    if (!garage || !garage.agentConfiguration) {
      return { content: `Sorry, I'm having trouble just now — please call us on ${PHONE} and we'll help.`, needsHumanAssistance: true };
    }
    const history = await prisma.chatMessage.findMany({
      where: { conversationId }, orderBy: { createdAt: 'asc' }, take: 12,
    });
    const isFirstReply = history.filter(m => m.role === 'assistant' || m.role === 'agent').length === 0;
    const firstName = (seedContact?.name || '').trim().split(/\s+/)[0] || undefined;

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: buildSystemPrompt(garage.agentConfiguration, garage.knowledgeDocuments as any, firstName, isFirstReply) },
      ...history.map(m => ({
        role: (m.role === 'assistant' || m.role === 'agent' ? 'assistant' : 'user') as 'assistant' | 'user',
        content: m.content,
      })),
      { role: 'user', content: message },
    ];

    for (let i = 0; i < 4; i++) {
      const resp = await getOpenAI().chat.completions.create({
        model: 'gpt-4o', temperature: 0.6, max_tokens: 320, messages, tools: tools(),
      });
      const m = resp.choices[0].message;
      if (m.tool_calls?.length) {
        messages.push(m as any);
        for (const tc of m.tool_calls) {
          let args: any = {};
          try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* ignore */ }
          const out = await runTool(tc.function.name, args);
          messages.push({ role: 'tool', tool_call_id: tc.id, content: out });
        }
        continue;
      }
      const content = (m.content || '').trim() || 'Sorry, could you say that again?';
      const needsHuman = /pass (it|this|you|that) (on |over )?to (the|our) team|i'll get someone|call us on/i.test(content);
      return { content, needsHumanAssistance: needsHuman };
    }
    return { content: `Let me pass you to our team — give us a call on ${PHONE}.`, needsHumanAssistance: true };
  } catch (e: any) {
    console.error('[MMH_CHAT] error:', e?.message);
    return { content: `Sorry, I'm having a moment — please call us on ${PHONE} and we'll sort it.`, needsHumanAssistance: true };
  }
}
