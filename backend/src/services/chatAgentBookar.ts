/**
 * Bookar chat agent — the text/chat counterpart to `optimised-bookar/agent.py`.
 *
 * Bookar is a UK garage-management system built by Vitara Commerce Ltd. James
 * Billington shipped a dedicated Partner API for ReceptionMate; the voice
 * agent has been live for a while, this is the chat mirror.
 *
 * Design mirrors chatAgentTyresoft.ts as closely as possible — same session
 * cache TTL / DB fallback shape, same tool-loop pattern, same error handling,
 * same "server-side guardrails" idea to stop the LLM inventing IDs.
 *
 * Key differences from Tyresoft:
 *   - Bookar uses an INSTANCE-BASED client (per-garage OAuth2 token cache) via
 *     BookarClient, not shared axios calls. Instance is built per-request from
 *     the garage's integrationProviderConfig (see bookarClient.ts).
 *   - Prices are per-vehicle: we NEVER quote a price without a live
 *     listServices() call for the caller's VRM. Bookar returns the exact price
 *     for that vehicle → matrix/fixed handled server-side, no math in the LLM.
 *   - Booking flow needs an EMAIL (Bookar requires it for confirmation).
 *   - Reference is a string (`BK-...` style) not a numeric sale number.
 *   - Manage-existing flow (retrieve/reschedule/cancel) is a first-class path,
 *     unlike Tyresoft/GH which force those into "take a message".
 */
import { prisma } from '../db.js';
import { notifyMessaging } from './messagingNotifications.js';
import OpenAI from 'openai';
import { logChatToolCall } from './chatToolLog.js';
import { notifyFlaggedConversation } from '../utils/push.js';
import {
  BookarClient,
  bookarClientFromConfig,
  BookarError,
  BookarAuthError,
  BookarCustomer,
  BookarVehicle,
  BookarService,
  BookarSlot,
  BookarBookingRequest,
  BookarBookingResponse,
} from './bookarClient.js';

// Lazy-load OpenAI client (same pattern as Tyresoft). Deferred so importing this
// module in a test/build without OPENAI_API_KEY set doesn't throw.
let openaiClient: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!openaiClient) {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured');
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openaiClient;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

interface ChatAgentResponse {
  content: string;
  needsHumanAssistance?: boolean;
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------
//
// We persist this JSONB blob to ChatConversation.sessionState so a caller who
// walks away for an hour can resume without re-collecting their VRM / name.
// In-memory cache (2h TTL) fronts the DB read to keep the hot path fast; the
// DB read is only hit on cache miss (server restart, LB failover, etc).
//
// Shape mirrors what the voice agent tracks in its own state machine but as
// plain JSON so we can survive a Node restart.
interface BookarSessionState {
  // Contact
  customerId?: number;          // Bookar customer.id if found via findCustomerByPhone
  customerName: string;         // full display name; falls back to first+last
  customerPhone: string;        // E.164 or UK-national — Bookar accepts either
  customerEmail: string;        // required by Bookar for booking confirmation email

  // Vehicle — populated after lookup_vehicle
  vrm: string;                  // cleaned (uppercase, no spaces)
  vehicle?: {
    make?: string;
    model?: string;
    mileage?: number;
    motExpiry?: string;         // Bookar's mot_expiry (ISO date)
    onFile: boolean;            // Bookar already knew this vehicle for this branch
  };

  // Services + slot
  servicesOptions?: BookarService[];              // last list_services result — DO NOT invent prices, always cross-check here
  selectedServiceIds: number[];                   // customer-picked service_ids to book
  availabilityOptions?: Array<{ date: string; slots?: string[]; time?: string }>; // last availability result, for slot cross-check
  selectedSlot?: BookarSlot;                      // {date, time} customer picked

  // Booking outcome
  bookingConfirmed: boolean;
  bookingReference?: string;
  bookingDetails?: string;                        // human-readable summary, e.g. "MOT on 2026-08-04 at 10:00"

  // Manage-existing flow (caller quoted a reference)
  existingBookingRef?: string;

  // Fallback
  lastTakeMessage?: string;                       // if we bailed out of the flow into message-taking

  // Housekeeping (added by saveSession/loadSession, not visible to tools directly)
  sessionUpdatedAt?: string;                      // ISO timestamp — used for TTL/warm-resume logic
}

// Empty starting state — kept as a function so each conversation gets its own object.
function emptySessionState(): BookarSessionState {
  return {
    customerName: '',
    customerPhone: '',
    customerEmail: '',
    vrm: '',
    selectedServiceIds: [],
    bookingConfirmed: false,
  };
}

// ---------------------------------------------------------------------------
// Session cache — 2h in-memory TTL, 8h DB fallback (matches chatAgentV2 tiers)
// ---------------------------------------------------------------------------
//
// The in-memory Map is per-process; the DB write on every mutation gives us
// cross-process resume (multiple Node instances behind a load balancer, or a
// PM2 restart mid-conversation).
const IN_MEMORY_TTL_MS = 2 * 60 * 60 * 1000;   // 2 hours
const WARM_RESUME_MS   = 8 * 60 * 60 * 1000;   // 8 hours — beyond this we cold-start with a fresh session

interface CachedSession {
  state: BookarSessionState;
  loadedAt: number;
}
const bookarSessions = new Map<string, CachedSession>();

async function loadSession(conversationId: string): Promise<BookarSessionState> {
  // Fast path: hot in-memory hit within TTL.
  const hit = bookarSessions.get(conversationId);
  if (hit && Date.now() - hit.loadedAt < IN_MEMORY_TTL_MS) {
    return hit.state;
  }

  // Cold path: pull from Postgres. Use raw SQL because ChatConversation.sessionState
  // is a Json? column and some historical Prisma clients typed it as any-loose,
  // so raw SQL sidesteps client-schema drift (same trick chatAgentV2 uses).
  try {
    const rows = await prisma.$queryRawUnsafe<
      Array<{ sessionState: any }>
    >(
      `SELECT "sessionState" FROM "ChatConversation" WHERE id = $1`,
      conversationId,
    );
    if (rows.length > 0 && rows[0].sessionState) {
      const raw = rows[0].sessionState as BookarSessionState & { sessionUpdatedAt?: string };
      const updatedAtIso = raw.sessionUpdatedAt;
      const ageMs = updatedAtIso ? Date.now() - new Date(updatedAtIso).getTime() : 0;
      // Beyond warm-resume window? Treat as a fresh conversation — this stops a
      // stale VRM from days ago poisoning a new "hi, I want to book" chat.
      if (ageMs > WARM_RESUME_MS) {
        console.log(`[BOOKAR_AGENT] Session for ${conversationId} expired (${Math.round(ageMs / 60000)}min) — starting fresh`);
        const fresh = emptySessionState();
        bookarSessions.set(conversationId, { state: fresh, loadedAt: Date.now() });
        return fresh;
      }
      // Preserve everything but stamp our in-memory copy so mutations propagate.
      const state: BookarSessionState = {
        ...emptySessionState(),
        ...raw,
      };
      bookarSessions.set(conversationId, { state, loadedAt: Date.now() });
      return state;
    }
  } catch (e: any) {
    console.error(`[BOOKAR_AGENT] Failed to load sessionState for ${conversationId}:`, e?.message);
  }

  // Nothing persisted → empty start.
  const fresh = emptySessionState();
  bookarSessions.set(conversationId, { state: fresh, loadedAt: Date.now() });
  return fresh;
}

async function saveSession(conversationId: string, state: BookarSessionState): Promise<void> {
  // Stamp updatedAt so TTL logic in loadSession is authoritative (don't rely on
  // ChatConversation.lastMessageAt — that's bumped by the webhook layer BEFORE
  // this function runs, so it's always "now" and TTL never fires).
  const toStore: BookarSessionState = {
    ...state,
    sessionUpdatedAt: new Date().toISOString(),
  };
  // Refresh in-memory cache.
  bookarSessions.set(conversationId, { state: toStore, loadedAt: Date.now() });

  // Best-effort DB persist. Never let a session-write failure break a chat reply.
  try {
    const json = JSON.stringify(toStore);
    await prisma.$executeRawUnsafe(
      `UPDATE "ChatConversation" SET "sessionState" = $1::jsonb WHERE id = $2`,
      json,
      conversationId,
    );
  } catch (e: any) {
    console.error(`[BOOKAR_AGENT] saveSession failed for ${conversationId}:`, e?.message);
  }
}

// Clears session on booking success / cancel — stops the LLM re-using the VRM
// after we've told the caller "you're all booked".
function clearSession(conversationId: string): void {
  bookarSessions.delete(conversationId);
  prisma
    .$executeRawUnsafe(
      `UPDATE "ChatConversation" SET "sessionState" = NULL WHERE id = $1`,
      conversationId,
    )
    .catch((e: any) => console.error(`[BOOKAR_AGENT] clearSession DB clear failed:`, e?.message));
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function toTitleCase(str: string): string {
  return String(str || '').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function cleanVrm(vrm: string): string {
  return String(vrm || '').toUpperCase().replace(/\s+/g, '');
}

function addDaysIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// Bookar's slot times come back as "HH:MM:SS"; normalise to "HH:MM" for the LLM
// so it doesn't parrot seconds back to the customer ("ten thirty and no seconds").
function normaliseTime(t: string): string {
  if (!t) return t;
  return t.length >= 5 ? t.slice(0, 5) : t;
}

// Money format for logs/summaries — the LLM has its own natural-language rule
// ("fifty-four pounds eighty-five"), this is just for [BOOKING CREATED] traces.
function fmtMoney(n: number): string {
  return `£${n.toFixed(2)}`;
}

// Very light phone normaliser — keeps digits and leading "+".
function normalisePhone(p: string): string {
  if (!p) return '';
  const trimmed = p.trim();
  if (trimmed.startsWith('+')) return '+' + trimmed.slice(1).replace(/[^\d]/g, '');
  return trimmed.replace(/[^\d]/g, '');
}

// ---------------------------------------------------------------------------
// Main entry — mirrors getTyresoftChatResponse signature line-for-line
// ---------------------------------------------------------------------------

export async function getBookarChatResponse(
  garageId: string,
  message: string,
  conversationId: string,
  seedContact?: { phone?: string; name?: string },
): Promise<ChatAgentResponse> {
  try {
    // Load garage + agent config + a handful of knowledge docs (same shape as Tyresoft).
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

    // Build the per-garage Bookar client from integrationProviderConfig. Returns
    // null if this garage hasn't been onboarded to Bookar yet — in that case
    // we run a fallback prompt that can still take a message but can't book.
    const client = bookarClientFromConfig(config.integrationProviderConfig);
    const hasCreds = !!client;

    console.log('[BOOKAR_AGENT] Config loaded:', {
      garageId,
      hasCreds,
      conversationId,
    });

    const isOpen = checkOpeningHours(config.weeklyOpeningHours);
    const session = await loadSession(conversationId);

    // Seed the session with caller-id / display name from the platform on the
    // very first turn — this is what lets us call findCustomerByPhone before
    // asking anything. WhatsApp / SMS / widget all pass a phone via seedContact.
    if (seedContact) {
      if (seedContact.phone && !session.customerPhone) {
        session.customerPhone = normalisePhone(seedContact.phone);
      }
      if (seedContact.name && !session.customerName) {
        session.customerName = seedContact.name;
      }
    }

    // messagingHumanHandoff opts a garage OUT of human-handoff tools if false.
    // Same convention as chatAgentTyresoft: DEFAULT ON (only disable if explicitly false).
    const messagingHandoff = (config as any).messagingHumanHandoff !== false;
    let tools = buildTools(hasCreds);
    if (!messagingHandoff) {
      tools = tools.filter(
        (t) => !['bk_take_message', 'bk_request_callback'].includes((t as any).function?.name),
      );
    }

    const sysPrompt = buildSystemPrompt(config, garage.knowledgeDocuments, isOpen, session, hasCreds, messagingHandoff);

    // Build message history — last 50 messages, oldest first.
    const previousMessages = (
      await prisma.chatMessage.findMany({
        where: { conversationId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      })
    ).reverse();

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: sysPrompt },
    ];
    for (const msg of previousMessages) {
      const role = msg.role === 'user' ? 'user' : 'assistant';
      messages.push({ role, content: msg.content });
    }

    // First-turn contact hints — same convention as Tyresoft. Only prepended
    // when there's no prior history (i.e. genuinely the caller's first message).
    let userContent = message;
    if (seedContact && previousMessages.length === 0) {
      const hints: string[] = [];
      if (seedContact.name)  hints.push(`[Customer name: ${seedContact.name}]`);
      if (seedContact.phone) hints.push(`[Customer phone: ${seedContact.phone}]`);
      if (hints.length) userContent = `${hints.join(' ')} ${message}`;
    }
    messages.push({ role: 'user', content: userContent });

    // Booking hot-path uses a slightly cooler temperature so the model stops
    // improvising — matches Tyresoft's rule of thumb.
    const inBookingFlow = session.selectedServiceIds.length > 0 || !!session.selectedSlot;
    const temperature = inBookingFlow ? 0.5 : 0.9;

    let response = await getOpenAI().chat.completions.create({
      model: 'gpt-4o',
      messages,
      temperature,
      max_tokens: 250,
      tools,
      tool_choice: 'auto',
    });

    // Tool-call loop — capped at 5 iterations to prevent runaway budgets on
    // a misbehaving prompt. Every tool call is logged for observability.
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
          console.error(
            `[BOOKAR_AGENT] Failed to parse tool args for ${call.function.name}:`,
            call.function.arguments,
          );
          args = {};
        }
        console.log(`[BOOKAR_AGENT] Tool call: ${call.function.name}`, args);

        const t0 = Date.now();
        const result = await executeTool(call.function.name, args, conversationId, garageId, client);
        logChatToolCall({
          conversationId,
          garageId,
          agentType: 'bookar',
          toolName: call.function.name,
          args,
          result,
          durationMs: Date.now() - t0,
        });
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

    const content =
      response.choices[0]?.message?.content ||
      "Sorry, I'm unable to respond right now. Please try again or call us directly.";

    // Persist session at end of every turn (best-effort — see saveSession).
    // Grab the LATEST in-memory snapshot in case a tool mutated it.
    const latest = bookarSessions.get(conversationId)?.state ?? session;
    await saveSession(conversationId, latest);

    return { content, needsHumanAssistance: false };
  } catch (error) {
    console.error('[BOOKAR_AGENT] Error:', error);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

function buildTools(hasCreds: boolean): OpenAI.Chat.ChatCompletionTool[] {
  // ── Always-on tools (work with or without Bookar creds) ──────────────────
  const tools: OpenAI.Chat.ChatCompletionTool[] = [
    {
      type: 'function',
      function: {
        name: 'bk_take_message',
        description:
          "Hand the customer to a human. ONLY use this when EITHER the customer explicitly asks to speak to a human, OR they make a request you genuinely cannot handle from your knowledge and tools (e.g. wants a service Bookar's list doesn't include, complaint, chasing a car already in the shop, out-of-scope). Do NOT use it for questions you can answer or bookings you can make yourself. Call it after collecting their message and phone number.",
        parameters: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'The customer message to pass on to the team' },
            phone:   { type: 'string', description: 'Customer phone number' },
          },
          required: ['message', 'phone'],
        },
      },
    },
  ];

  if (!hasCreds) return tools;

  // ── Bookar-enabled tools — only surfaced when the garage has creds ───────
  tools.push(
    {
      type: 'function',
      function: {
        name: 'bk_find_customer_by_phone',
        description:
          "Look up an existing customer by their phone number. Call this ON THE FIRST TURN if you know the customer's phone (from the seed contact hint). If a match is returned we get their name + linked vehicles — greet them naturally and skip re-collecting basics.",
        parameters: {
          type: 'object',
          properties: {
            phone: { type: 'string', description: 'Customer phone number' },
          },
          required: ['phone'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'bk_lookup_vehicle',
        description:
          'Look up a vehicle by registration plate. MUST be called before quoting any price. Returns make/model/mot_expiry/on_file + any advisories the garage has recorded. Also reveals whether the vehicle is on file at this branch — if it is, greet the caller by acknowledging the vehicle rather than re-collecting it.',
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
        name: 'bk_list_services',
        description:
          'List services + REAL prices for THIS vehicle. MUST be called before quoting any price — Bookar prices are vehicle-specific and matrix-based. NEVER invent, estimate or carry over a price from another conversation. If the caller asks for a service not in the returned list (e.g. "wheel alignment" and the list is only MOT/Service), do NOT invent it — fall back to bk_take_message.',
        parameters: {
          type: 'object',
          properties: {
            vrm: { type: 'string', description: 'Vehicle registration number, already looked up via bk_lookup_vehicle' },
          },
          required: ['vrm'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'bk_list_availability',
        description:
          "Fetch the next available slots for the chosen service(s). Call ONLY after the customer has picked which service(s) they want. Defaults date range to today → today+14days if unspecified. Offer only 1-2 slot options at a time — don't dump the whole list.",
        parameters: {
          type: 'object',
          properties: {
            service_ids: {
              type: 'array',
              items: { type: 'number' },
              description: 'Bookar service IDs the customer wants, exactly as returned by bk_list_services',
            },
            date_from: { type: 'string', description: 'Earliest date to search (YYYY-MM-DD). Optional; defaults to today.' },
            date_to:   { type: 'string', description: 'Latest date to search (YYYY-MM-DD). Optional; defaults to today+14.' },
          },
          required: ['service_ids'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'bk_confirm_slot',
        description:
          "Save the customer's chosen date + time into the session. Call as soon as the customer picks a slot so it's remembered when we create the booking.",
        parameters: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'Slot date YYYY-MM-DD, exactly as returned by bk_list_availability' },
            time: { type: 'string', description: 'Slot time HH:MM, exactly as returned by bk_list_availability' },
          },
          required: ['date', 'time'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'bk_save_customer_details',
        description:
          "Save the customer's name, phone and email into the session. Bookar requires the email for booking confirmation — do NOT call bk_create_booking without an email. Call as soon as you have any subset of these three; you can call it again to add missing pieces.",
        parameters: {
          type: 'object',
          properties: {
            name:  { type: 'string', description: 'Full name of the customer' },
            phone: { type: 'string', description: 'UK phone number of the customer' },
            email: { type: 'string', description: 'Email address (REQUIRED for Bookar confirmation)' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'bk_create_booking',
        description:
          'Create the booking on Bookar. Idempotent — safe to retry with the same conversation. ONLY call after the customer has said YES to the read-back summary AND you have: VRM (via bk_lookup_vehicle), service_ids (via bk_list_services + caller choice), a slot (via bk_confirm_slot), and name + phone + email (via bk_save_customer_details).',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'bk_retrieve_booking',
        description:
          "Retrieve an existing booking by its reference (e.g. BK-... or numeric). Call when a caller quotes a reference and wants to check, change or cancel — you MUST fetch the current state before offering to reschedule/cancel so we don't act on stale info.",
        parameters: {
          type: 'object',
          properties: {
            reference: { type: 'string', description: 'The booking reference the customer quoted' },
          },
          required: ['reference'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'bk_reschedule_booking',
        description:
          "Reschedule an existing booking to a new date + time. Requires the booking reference (either quoted by the caller, or the one we just created earlier this session). You MUST have called bk_list_availability + bk_confirm_slot first so we're moving to a real available slot.",
        parameters: {
          type: 'object',
          properties: {
            reference: { type: 'string', description: 'The booking reference to reschedule' },
            date:      { type: 'string', description: 'New date YYYY-MM-DD, exactly as returned by bk_list_availability' },
            time:      { type: 'string', description: 'New time HH:MM, exactly as returned by bk_list_availability' },
          },
          required: ['reference', 'date', 'time'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'bk_cancel_booking',
        description:
          'Cancel an existing booking with a short reason. ONLY call after the customer has explicitly confirmed they want to cancel — never assume.',
        parameters: {
          type: 'object',
          properties: {
            reference: { type: 'string', description: 'The booking reference to cancel' },
            reason:    { type: 'string', description: "Short reason string, e.g. 'customer request', 'vehicle sold', 'no longer needed'" },
          },
          required: ['reference', 'reason'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'bk_request_callback',
        description:
          'Log a callback request when the customer explicitly asks to be called back rather than booking now. Distinct from bk_take_message — use this specifically when the customer says "can someone call me?" or prefers a phone callback.',
        parameters: {
          type: 'object',
          properties: {
            name:  { type: 'string', description: 'Customer name' },
            phone: { type: 'string', description: 'Phone number to call back on' },
            notes: { type: 'string', description: 'Brief reason for callback or what they want to discuss (optional)' },
          },
          required: ['name', 'phone'],
        },
      },
    },
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
  garageId: string,
  client: BookarClient | null,
): Promise<any> {
  const session = await loadSession(conversationId);

  try {
    switch (name) {
      // ── Human handoff (always available) ──────────────────────────────
      case 'bk_take_message': {
        const msg   = String(args.message || '').trim();
        const phone = normalisePhone(String(args.phone || ''));
        console.log(`[BOOKAR_AGENT] Take message: phone=${phone}, message=${msg}`);
        session.lastTakeMessage = msg;
        if (phone && !session.customerPhone) session.customerPhone = phone;
        await saveSession(conversationId, session);

        if (conversationId) {
          await prisma.chatConversation.updateMany({
            where: { id: conversationId },
            data: {
              needsAttention: true,
              agentPaused: true,
              ...(session.customerName  ? { customerName:  session.customerName }  : {}),
              ...(session.customerPhone ? { customerPhone: session.customerPhone } : {}),
            },
          });
          void notifyFlaggedConversation(conversationId);
          void notifyMessaging({ conversationId, event: 'escalated' });
          console.log(`[BOOKAR_AGENT] Conversation ${conversationId} flagged as needsAttention`);
        }
        return {
          success: true,
          message: 'Message taken. The team has been notified and will get back to you shortly.',
        };
      }

      case 'bk_request_callback': {
        const name  = String(args.name  || '').trim();
        const phone = normalisePhone(String(args.phone || ''));
        const notes = String(args.notes || '').trim();
        console.log(`[BOOKAR_AGENT] [CALLBACK REQUEST] ${JSON.stringify({
          timestamp: new Date().toUTCString(),
          channel: 'chat',
          name,
          phone,
          notes,
        })}`);
        if (name)  session.customerName  = name;
        if (phone) session.customerPhone = phone;
        await saveSession(conversationId, session);

        if (conversationId) {
          await prisma.chatConversation.updateMany({
            where: { id: conversationId },
            data: {
              needsAttention: true,
              agentPaused: true,
              ...(name  ? { customerName:  name  } : {}),
              ...(phone ? { customerPhone: phone } : {}),
            },
          });
          void notifyFlaggedConversation(conversationId);
          void notifyMessaging({ conversationId, event: 'escalated' });
        }
        return { success: true, message: 'Callback request logged.' };
      }

      // ── Bookar-backed tools — need creds from here on ─────────────────
      case 'bk_find_customer_by_phone': {
        if (!client) return { error: 'Bookar API not configured for this garage' };
        const phone = normalisePhone(String(args.phone || session.customerPhone || ''));
        if (!phone) return { found: false, message: 'No phone number provided.' };
        const cust = await client.findCustomerByPhone(phone);
        if (!cust) {
          console.log(`[BOOKAR_AGENT] findCustomerByPhone: no match for ${phone}`);
          // Even a no-match answer is useful to the LLM — it tells us to collect
          // the name fresh rather than assuming it's already known.
          return { found: false };
        }
        // Persist what Bookar knows about the customer so we don't ask twice.
        session.customerId = cust.id;
        const displayName =
          cust.name ||
          [cust.first_name, cust.last_name].filter(Boolean).join(' ').trim();
        if (displayName && !session.customerName) session.customerName = displayName;
        if (cust.email && !session.customerEmail) session.customerEmail = cust.email;
        // Prefer mobile if we have it; else fall through to the phone we queried by.
        if ((cust.mobile_phone || cust.phone) && !session.customerPhone) {
          session.customerPhone = normalisePhone(cust.mobile_phone || cust.phone || '');
        }
        await saveSession(conversationId, session);
        console.log(
          `[BOOKAR_AGENT] findCustomerByPhone: matched id=${cust.id} name=${displayName || '(unknown)'} vehicles=${cust.vehicles?.length ?? 0}`,
        );
        return {
          found: true,
          customer_id: cust.id,
          name: displayName || undefined,
          email: cust.email,
          phone: cust.mobile_phone || cust.phone,
          vehicles: (cust.vehicles || []).map((v) => ({
            vrm: v.vrm,
            make: toTitleCase(v.make || ''),
            model: toTitleCase(v.model || ''),
          })),
        };
      }

      case 'bk_lookup_vehicle': {
        if (!client) return { error: 'Bookar API not configured for this garage' };
        const vrm = cleanVrm(String(args.vrm || ''));
        if (!vrm) return { error: 'vrm required' };
        const vehicle = await client.lookupVehicle(vrm);
        // Title-case any ALL-CAPS make/model from DVLA so the LLM doesn't shout at the customer.
        const make  = toTitleCase(vehicle.make  || '');
        const model = toTitleCase(vehicle.model || '');
        session.vrm = vrm;
        session.vehicle = {
          make,
          model,
          mileage: vehicle.mileage,
          motExpiry: vehicle.mot_expiry,
          onFile: !!vehicle.on_file,
        };
        // If Bookar links this vehicle to a customer we didn't already know about,
        // capture the id so create_booking can use existing-customer shape.
        if (vehicle.customer?.id && !session.customerId) {
          session.customerId = vehicle.customer.id;
          const linkedName = [vehicle.customer.first_name, vehicle.customer.last_name]
            .filter(Boolean)
            .join(' ')
            .trim();
          if (linkedName && !session.customerName) session.customerName = linkedName;
        }
        await saveSession(conversationId, session);
        console.log(
          `[BOOKAR_AGENT] lookupVehicle OK: ${vrm} → ${make} ${model} onFile=${vehicle.on_file} mot=${vehicle.mot_expiry || 'n/a'}`,
        );
        // Return a slimmed-down view — the LLM doesn't need every advisory field,
        // just the highlights it might read back to the customer.
        return {
          vrm,
          make,
          model,
          mileage: vehicle.mileage,
          mot_expiry: vehicle.mot_expiry,
          on_file: !!vehicle.on_file,
          advisories_count: vehicle.advisories?.length ?? 0,
          recent_history: (vehicle.history || []).slice(0, 3).map((h) => ({
            date: h.date,
            service: h.service,
            outcome: h.outcome,
            status: h.status,
          })),
        };
      }

      case 'bk_list_services': {
        if (!client) return { error: 'Bookar API not configured for this garage' };
        const vrm = cleanVrm(String(args.vrm || session.vrm || ''));
        if (!vrm) {
          return {
            error: 'vehicle_registration_required',
            directive:
              'A vehicle registration is required before listing services (prices are per-vehicle). Ask for the plate and call bk_lookup_vehicle first.',
          };
        }
        const services = await client.listServices(vrm);
        // Cache the returned catalogue in session — used later by bk_create_booking
        // to reconstruct the human-readable summary (and to price-check).
        session.servicesOptions = services;
        await saveSession(conversationId, session);
        console.log(`[BOOKAR_AGENT] listServices: vrm=${vrm}, count=${services.length}`);

        // Format for the LLM — keep it small; strip disabled entries so the
        // model can't accidentally offer something the garage has switched off.
        const enabled = services.filter((s) => s.enabled !== false);
        return {
          count: enabled.length,
          services: enabled.map((s) => ({
            id: s.id,
            name: s.name,
            type: s.type,
            price: fmtMoney(s.price?.total ?? 0),
            price_numeric: s.price?.total ?? 0,
          })),
        };
      }

      case 'bk_list_availability': {
        if (!client) return { error: 'Bookar API not configured for this garage' };
        const serviceIds: number[] = Array.isArray(args.service_ids) ? args.service_ids.map(Number).filter(Boolean) : [];
        if (serviceIds.length === 0) {
          return { error: 'At least one service_id is required. Call bk_list_services first and pass the chosen ids.' };
        }

        // Cross-check ids against what listServices last returned — the LLM
        // occasionally invents an id when the customer paraphrases a service.
        if (session.servicesOptions?.length) {
          const known = new Set(session.servicesOptions.map((s) => s.id));
          const unknown = serviceIds.filter((id) => !known.has(id));
          if (unknown.length > 0) {
            return {
              error: 'unknown_service_id',
              directive: `Service id(s) ${unknown.join(', ')} were not in the last bk_list_services result. Re-check with the customer and pick from the real id list.`,
            };
          }
        }

        // Server-side guardrail: VRM must be captured for any availability check.
        if (!session.vrm) {
          return {
            error: 'vehicle_registration_required',
            directive: 'Ask for the plate and call bk_lookup_vehicle before checking availability.',
          };
        }

        const dateFrom = String(args.date_from || todayIso());
        const dateTo   = String(args.date_to   || addDaysIso(14));
        const availability = await client.listAvailability(serviceIds, dateFrom, dateTo);
        session.selectedServiceIds = serviceIds;
        session.availabilityOptions = availability;
        // Clear any previously-picked slot — it belongs to a different service.
        session.selectedSlot = undefined;
        await saveSession(conversationId, session);
        console.log(
          `[BOOKAR_AGENT] listAvailability: services=${serviceIds.join(',')}, ${dateFrom}→${dateTo}, days=${availability.length}`,
        );

        // Flatten into a short "next few slots" list for the LLM — matches the
        // voice agent's "offer 1-2 slots" style. We keep max 6 across all days.
        const flat: Array<{ date: string; time: string }> = [];
        for (const day of availability) {
          const times = day.slots && day.slots.length > 0 ? day.slots : (day.time ? [day.time] : []);
          for (const t of times) {
            flat.push({ date: day.date, time: normaliseTime(t) });
            if (flat.length >= 6) break;
          }
          if (flat.length >= 6) break;
        }
        return {
          count: flat.length,
          next_slots: flat,
          searched: { from: dateFrom, to: dateTo, service_ids: serviceIds },
        };
      }

      case 'bk_confirm_slot': {
        const date = String(args.date || '').trim();
        const time = normaliseTime(String(args.time || '').trim());
        if (!date || !time) return { error: 'date and time both required' };

        // Cross-check against the last availability result so we can't book a
        // slot the API didn't actually offer.
        const found = flattenAvailability(session.availabilityOptions || []).find(
          (s) => s.date === date && s.time === time,
        );
        if (!found) {
          return {
            error: 'slot_not_available',
            directive: 'That date/time was not in the last bk_list_availability result. Call bk_list_availability again and pick from the returned slots.',
          };
        }
        session.selectedSlot = { date, time: time.length === 5 ? `${time}:00` : time };
        await saveSession(conversationId, session);
        console.log(`[BOOKAR_AGENT] Slot confirmed: ${date} ${time}`);
        return { success: true, date, time };
      }

      case 'bk_save_customer_details': {
        const name  = String(args.name  || '').trim();
        const phone = normalisePhone(String(args.phone || ''));
        const email = String(args.email || '').trim();
        if (name)  session.customerName  = name;
        if (phone) session.customerPhone = phone;
        if (email) session.customerEmail = email;
        await saveSession(conversationId, session);
        console.log(
          `[BOOKAR_AGENT] Customer details saved: name=${session.customerName}, phone=${session.customerPhone}, email=${session.customerEmail}`,
        );

        // Mirror to the ChatConversation so name/phone show in the portal even
        // before a booking completes (same UX pattern as chatAgentTyresoft).
        if (conversationId && (name || phone)) {
          await prisma.chatConversation.updateMany({
            where: { id: conversationId },
            data: {
              ...(name  ? { customerName:  name  } : {}),
              ...(phone ? { customerPhone: phone } : {}),
            },
          });
        }
        return {
          success: true,
          have_name: !!session.customerName,
          have_phone: !!session.customerPhone,
          have_email: !!session.customerEmail,
        };
      }

      case 'bk_create_booking': {
        if (!client) return { error: 'Bookar API not configured for this garage' };
        return await bookarCreateBooking(session, conversationId, garageId, client);
      }

      case 'bk_retrieve_booking': {
        if (!client) return { error: 'Bookar API not configured for this garage' };
        const ref = String(args.reference || '').trim();
        if (!ref) return { error: 'reference required' };
        const booking = await client.retrieveBooking(ref);
        session.existingBookingRef = ref;
        await saveSession(conversationId, session);
        console.log(`[BOOKAR_AGENT] retrieveBooking OK: ${ref} status=${booking.status}`);
        return {
          reference: booking.reference,
          status: booking.status,
          appointment: booking.appointment,
          customer: booking.customer,
          vehicle: booking.vehicle,
        };
      }

      case 'bk_reschedule_booking': {
        if (!client) return { error: 'Bookar API not configured for this garage' };
        const ref  = String(args.reference || session.existingBookingRef || '').trim();
        const date = String(args.date || '').trim();
        const time = normaliseTime(String(args.time || '').trim());
        if (!ref || !date || !time) {
          return { error: 'reference, date and time all required' };
        }
        // Same cross-check as bk_confirm_slot — the new slot must have come from
        // a real availability response.
        const found = flattenAvailability(session.availabilityOptions || []).find(
          (s) => s.date === date && s.time === time,
        );
        if (!found) {
          return {
            error: 'slot_not_available',
            directive: 'That date/time was not in the last bk_list_availability result. Call bk_list_availability again and pick from the returned slots.',
          };
        }
        const wireTime = time.length === 5 ? `${time}:00` : time;
        const booking = await client.rescheduleBooking(ref, { date, time: wireTime });
        console.log(`[BOOKAR_AGENT] rescheduleBooking OK: ${ref} → ${date} ${time}`);
        return {
          success: true,
          reference: booking.reference,
          status: booking.status,
          appointment: booking.appointment,
        };
      }

      case 'bk_cancel_booking': {
        if (!client) return { error: 'Bookar API not configured for this garage' };
        const ref    = String(args.reference || session.existingBookingRef || '').trim();
        const reason = String(args.reason    || 'customer request').trim();
        if (!ref) return { error: 'reference required' };
        const result = await client.cancelBooking(ref, reason);
        console.log(`[BOOKAR_AGENT] cancelBooking OK: ${ref} reason=${reason}`);
        // If the caller cancelled the booking we just created earlier this
        // session, drop our booked-state so we don't accidentally re-quote.
        if (session.bookingReference === ref) {
          session.bookingConfirmed = false;
          session.bookingReference = undefined;
          session.bookingDetails = undefined;
          await saveSession(conversationId, session);
        }
        return {
          success: true,
          reference: result.reference || ref,
          status: result.status,
          reason: result.reason || reason,
        };
      }

      default:
        return { error: 'Unknown tool' };
    }
  } catch (error: any) {
    // Surface Bookar-specific errors distinctly so the LLM can decide whether
    // it's recoverable (e.g. slot taken) vs terminal (e.g. auth broken → take_message).
    if (error instanceof BookarAuthError) {
      console.error(`[BOOKAR_AGENT] Auth error in ${name}:`, error.message);
      return {
        error: 'bookar_auth_error',
        directive:
          'The garage credentials for the booking system are not working right now. Apologise briefly and use bk_take_message so the team can follow up.',
      };
    }
    if (error instanceof BookarError) {
      console.error(`[BOOKAR_AGENT] Bookar API error in ${name}:`, error.message, error.body);
      return {
        error: 'bookar_api_error',
        status: error.status,
        message: error.message,
        body: error.body,
      };
    }
    console.error(`[BOOKAR_AGENT] Tool error (${name}):`, error?.message || error);
    return { error: error?.message || 'Tool execution failed' };
  }
}

// Flatten availability payload (which comes back as day-grouped) into a flat
// list of {date, time} so cross-checks against a picked slot are simple. Times
// are normalised to HH:MM so a HH:MM comparison against the LLM's args works.
function flattenAvailability(
  availability: Array<{ date: string; slots?: string[]; time?: string }>,
): Array<{ date: string; time: string }> {
  const flat: Array<{ date: string; time: string }> = [];
  for (const day of availability) {
    const times = day.slots && day.slots.length > 0 ? day.slots : (day.time ? [day.time] : []);
    for (const t of times) {
      flat.push({ date: day.date, time: normaliseTime(t) });
    }
  }
  return flat;
}

// ---------------------------------------------------------------------------
// Booking creation — validates session state, calls Bookar, persists to portal
// ---------------------------------------------------------------------------

async function bookarCreateBooking(
  session: BookarSessionState,
  conversationId: string,
  garageId: string,
  client: BookarClient,
): Promise<any> {
  // ── Preflight checks — bail early with a directive the LLM can act on ──
  if (!session.vrm) {
    return { error: 'no_vrm', directive: 'Ask for the plate and call bk_lookup_vehicle before booking.' };
  }
  if (!session.selectedServiceIds.length) {
    return { error: 'no_services', directive: 'Call bk_list_services and get the customer to pick a service first.' };
  }
  if (!session.selectedSlot) {
    return { error: 'no_slot', directive: 'Call bk_list_availability, offer slots, and call bk_confirm_slot once the customer picks one.' };
  }
  if (!session.customerName)  return { error: 'no_name',  directive: 'Ask for the customer name and call bk_save_customer_details.' };
  if (!session.customerPhone) return { error: 'no_phone', directive: 'Confirm the phone number and call bk_save_customer_details.' };
  if (!session.customerEmail) return { error: 'no_email', directive: "Ask for an email address (required for Bookar's confirmation) and call bk_save_customer_details." };

  // ── Build the request body ────────────────────────────────────────────
  // If we already have a Bookar customer.id from find_customer_by_phone or
  // lookup_vehicle, use the existing-customer shape; otherwise send a new one.
  const nameParts = session.customerName.trim().split(/\s+/);
  const firstName = nameParts[0] || '';
  const lastName  = nameParts.slice(1).join(' ') || '';

  const body: BookarBookingRequest = {
    customer: session.customerId
      ? { id: session.customerId }
      : {
          first_name: firstName,
          last_name: lastName || undefined,
          email: session.customerEmail,
          phone: session.customerPhone,
        },
    vehicle: { vrm: session.vrm },
    service_ids: session.selectedServiceIds,
    slot: {
      date: session.selectedSlot.date,
      time: session.selectedSlot.time,
    },
  };

  // Idempotency key — reuse the conversationId so a retry within the same
  // conversation returns the same booking rather than duplicating.
  const idempotencyKey = `bk-chat-${conversationId}-${session.vrm}-${session.selectedSlot.date}-${session.selectedSlot.time}`;

  let booking: BookarBookingResponse;
  try {
    booking = await client.createBooking(body, idempotencyKey);
  } catch (e: any) {
    if (e instanceof BookarError) {
      console.error(`[BOOKAR_AGENT] createBooking failed (status=${e.status}):`, e.body);
      return {
        error: 'booking_failed',
        status: e.status,
        details: e.body,
        message: e.message,
      };
    }
    console.error(`[BOOKAR_AGENT] createBooking failed:`, e?.message);
    return { error: 'booking_failed', message: e?.message };
  }

  // ── Session + portal persistence ──────────────────────────────────────
  const services = session.servicesOptions || [];
  const chosen = session.selectedServiceIds
    .map((id) => services.find((s) => s.id === id))
    .filter((s): s is BookarService => !!s);

  const summary = chosen.length
    ? `${chosen.map((s) => s.name).join(', ')} on ${session.selectedSlot.date} at ${normaliseTime(session.selectedSlot.time)}`
    : `Booking on ${session.selectedSlot.date} at ${normaliseTime(session.selectedSlot.time)}`;

  // Sum of quoted service prices for capturedRevenue. Bookar returns per-service
  // totals so this is trivially deterministic — no LLM arithmetic.
  const totalRevenue = chosen.reduce((sum, s) => sum + (s.price?.total ?? 0), 0);

  session.bookingConfirmed = true;
  session.bookingReference = booking.reference;
  session.bookingDetails = summary;
  await saveSession(conversationId, session);

  // Persist headline booking fields to the ChatConversation so they show in
  // the portal inbox (same fields the voice agent writes to Call).
  try {
    await prisma.chatConversation.updateMany({
      where: { id: conversationId },
      data: {
        customerName: session.customerName,
        customerPhone: session.customerPhone,
        confirmedBooking: true,
        bookingDetails: summary,
        capturedRevenue: totalRevenue > 0 ? totalRevenue : null,
      },
    });
  } catch (e: any) {
    // Non-fatal — the booking is already live on Bookar's side. Just log.
    console.error(`[BOOKAR_AGENT] Failed to persist booking to ChatConversation:`, e?.message);
  }

  // Structured booking log — same format as the voice agent's [BOOKING CREATED]
  // trace so ops search works across channels.
  console.log(
    `[BOOKING CREATED] ${JSON.stringify({
      timestamp: new Date().toUTCString(),
      channel: 'chat',
      agent: 'bookar',
      reference: booking.reference,
      customer: session.customerName,
      phone: session.customerPhone,
      email: session.customerEmail,
      vrm: session.vrm,
      vehicle: session.vehicle ? `${session.vehicle.make || ''} ${session.vehicle.model || ''}`.trim() : '',
      services: chosen.map((s) => `${s.name} (${fmtMoney(s.price?.total ?? 0)})`).join(', '),
      date: session.selectedSlot.date,
      time: normaliseTime(session.selectedSlot.time),
      revenue: fmtMoney(totalRevenue),
      garageId,
    })}`,
  );

  // Return a compact success payload — the LLM reads the reference back and
  // wraps up. We DO NOT clear the session yet: caller might want to change
  // something in the same turn ("actually can we move it to 2pm?"). Session
  // will naturally roll over via TTL / warm-resume logic.
  return {
    success: true,
    reference: booking.reference,
    status: booking.status,
    appointment: booking.appointment,
    services: chosen.map((s) => s.name),
    total: fmtMoney(totalRevenue),
  };
}

// ---------------------------------------------------------------------------
// System prompt — mirrors chatAgentTyresoft's shape (persona → about → hours →
// knowledge → per-garage rules/FAQs/fields → booking flow → active session)
// ---------------------------------------------------------------------------

function buildSystemPrompt(
  config: any,
  knowledgeDocs: any[],
  isOpen: boolean,
  session: BookarSessionState,
  hasCreds: boolean,
  humanEscalation: boolean,
): string {
  const branchName = config.branchName || 'our garage';
  const agentName = (config.agentName || '').trim();
  const who = agentName ? `${agentName}, a friendly receptionist` : 'a friendly receptionist';

  let prompt = `You are ${who} at ${branchName}, a UK vehicle service centre. ${config.greetingLine || ''}\n\n`;

  // ── Current date & time (London) — mirrors chatAgentV2 pattern ───────────
  // Without this the LLM defaults to its training cutoff and picks past dates
  // for "next week" queries. Same block chatAgentV2 uses at line ~3034.
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
  prompt += `Current date and time: ${nowLondon}\n\n`;

  // ── Voice ─────────────────────────────────────────────────────────────
  prompt += `HOW YOU TALK — like a real person texting, NOT an essay:\n`;
  prompt += `- Keep every reply to ONE short sentence. Never a paragraph — a real person wouldn't.\n`;
  prompt += `- Warm, natural, British English (tyre, kerb, MOT; "brilliant", "no worries", "cheers"). One question at a time.\n`;
  prompt += `- Money: write natural words, e.g. "fifty-four pounds eighty-five pence", not "£54.85".\n`;
  prompt += `- Dates: "the 12th of October", "Tuesday next week", not "2026-10-12".\n`;
  prompt += `- No lists or bullet points. No corporate filler ("Certainly!", "Of course!", "Great!"). Never sound like a bot.\n`;
  prompt += `- Never mention tool names or internal steps.\n\n`;

  // ── About us ──────────────────────────────────────────────────────────
  prompt += `About us:\n`;
  if (config.branchAddress) prompt += `Address: ${config.branchAddress}\n`;
  if (config.phoneNumber)   prompt += `Phone: ${config.phoneNumber}\n`;
  if (config.emailAddress)  prompt += `Email: ${config.emailAddress}\n`;
  if (config.websiteUrl)    prompt += `Website: ${config.websiteUrl}\n`;
  prompt += `\n`;

  // ── Opening hours ─────────────────────────────────────────────────────
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

  // ── Knowledge docs (garage-specific FAQs uploaded by the customer) ────
  if (knowledgeDocs.length) {
    prompt += `Additional info:\n`;
    for (const doc of knowledgeDocs) {
      if (doc.title) prompt += `${doc.title}:\n`;
      prompt += `${doc.content}\n\n`;
    }
  }

  // ── Per-garage custom rules / FAQs / data-collection fields ──────────
  // Same structure as chatAgentTyresoft — this is where a garage owner tweaks
  // agent behaviour without a code deploy.
  const rulesArr = Array.isArray(config.customRules)
    ? config.customRules
        .filter((r: any) => r && typeof r === 'object' && r.active === true && (r.text || '').trim())
        .map((r: any) => `- ${String(r.text).trim()}`)
    : [];
  if (rulesArr.length > 0) {
    prompt += `RULES YOU MUST FOLLOW (these override anything else in this prompt):\n${rulesArr.join('\n')}\n\n`;
  }

  const faqArr = Array.isArray(config.faqs)
    ? config.faqs
        .filter((f: any) => f && (f.question || f.q) && (f.answer || f.a))
        .map((f: any) => `Q: ${String(f.question || f.q).trim()}\nA: ${String(f.answer || f.a).trim()}`)
    : [];
  if (faqArr.length > 0) {
    prompt += `COMMON QUESTIONS — answer from these when a customer asks something similar; do NOT invent an answer:\n${faqArr.join('\n')}\n\n`;
  }

  const fieldArr = Array.isArray(config.dataCollectionFields)
    ? config.dataCollectionFields
        .filter((f: any) => f && f.active === true && (f.label || f.key))
        .map((f: any) => {
          const label = String(f.label || f.key).trim();
          const tag = f.required ? '(required)' : '(only if relevant)';
          const instr = (f.instruction || '').trim() ? ` — ${String(f.instruction).trim()}` : '';
          return `- ${label} ${tag}${instr}`;
        })
    : [];
  if (fieldArr.length > 0) {
    prompt += `INFORMATION TO COLLECT during the chat (ask naturally, one at a time, don't interrogate):\n${fieldArr.join('\n')}\n\n`;
  }

  // ── Booking flow (only if creds are present) ─────────────────────────
  if (hasCreds) {
    prompt += `\nBOOKING FLOW — follow in order, one step per reply:\n\n`;

    prompt += `1. FIRST CONTACT: If you already know the customer's phone (from the seed contact hint at the top of their first message), call bk_find_customer_by_phone. If it returns found=true, greet them by name and acknowledge their linked vehicle(s) — do NOT re-ask for name if we got it back.\n`;
    prompt += `2. NAME: If we don't already have a name, ask for it in one short sentence.\n`;
    prompt += `3. REG: Ask for their vehicle registration. Once you have it, call bk_lookup_vehicle. Read back the make/model naturally, e.g. "I can see that's a 2019 Ford Focus — is that right?" If mot_expiry is present, weave it in naturally if relevant.\n`;
    prompt += `4. SERVICES: Call bk_list_services with the same VRM. Quote prices ONLY from the returned list — never invent, estimate or carry over a price from memory. If the customer asks for a service NOT in the returned list (e.g. wheel alignment but the list only has MOT/Service), do NOT invent it — apologise briefly and fall back to bk_take_message so the team can help.\n`;
    prompt += `5. AVAILABILITY: Once the customer picks a service, call bk_list_availability with the chosen service_ids. Offer 1 or 2 slots naturally — don't dump the whole list.\n`;
    prompt += `6. SLOT: When the customer picks a slot, IMMEDIATELY call bk_confirm_slot with the exact date + time from the availability result.\n`;
    prompt += `7. EMAIL + PHONE: Ask for an email (required for Bookar's confirmation) and confirm the phone. Call bk_save_customer_details as soon as you have any missing pieces — you can call it multiple times.\n`;
    prompt += `8. READ-BACK: Summarise the whole booking in ONE sentence — service, day, time, name. Ask "shall I confirm?"\n`;
    prompt += `9. CREATE: Only after an explicit yes, call bk_create_booking. NEVER say the booking is done before this tool has returned success.\n`;
    prompt += `10. AFTER SUCCESS: Read the reference back naturally, e.g. "You're all booked in — your reference is [reference]. We'll see you [day] at [time]. Anything else?"\n\n`;

    prompt += `MANAGING EXISTING BOOKINGS:\n`;
    prompt += `- If the caller quotes a reference and wants to check, change or cancel: call bk_retrieve_booking FIRST so you're working from the current state.\n`;
    prompt += `- To move: call bk_list_availability (with the same service_ids you retrieve), bk_confirm_slot, then bk_reschedule_booking.\n`;
    prompt += `- To cancel: get an explicit "yes I want to cancel" before calling bk_cancel_booking. Never assume.\n\n`;

    prompt += `HARD RULES:\n`;
    prompt += `- NEVER quote a price without a live bk_list_services call for THIS vehicle in THIS conversation.\n`;
    prompt += `- NEVER claim a booking is confirmed until bk_create_booking has returned success.\n`;
    prompt += `- NEVER call bk_create_booking twice in one conversation. If a booking has already been created in this session (session.bookingReference is set) and the customer wants a different slot, use bk_reschedule_booking with that reference — do NOT create a second booking.\n`;
    prompt += `- NEVER re-run bk_lookup_vehicle for a VRM already captured in this session.\n`;
    prompt += `- NEVER ask for information already saved in the active session (see below).\n`;
    prompt += `- If the customer wants a service that isn't in the bk_list_services result, do NOT try to force it — use bk_take_message so a human can follow up.\n`;
    prompt += `- CRITICAL: When a customer provides their name, phone number, email or reg, do NOT greet them again or start over. Continue from where you left off.\n`;
    prompt += `- CRITICAL: If they give only their name and you still need phone/email, say "Thanks [name] — what's the best number to reach you on?" — do NOT say "Hello [name]! How can I assist you today?"\n`;
    prompt += `- Never use markdown: no **bold**, no bullets, no dashes. Plain sentences only.\n`;

    if (humanEscalation) {
      prompt += `- If the customer wants to speak to a human, or asks something you genuinely can't handle:\n`;
      prompt += `  Ask what their message is and confirm you have their phone number, then call bk_take_message and reply: "I've passed your message on to the team. Someone will get back to you shortly."\n`;
      prompt += `  Do NOT continue trying to help after bk_take_message — the conversation is handed off.\n`;
      prompt += `- If the customer explicitly asks to be called back:\n`;
      prompt += `  Get their name + best number if not already known, call bk_request_callback, then say: "No problem — I've logged a callback request and someone will give you a ring shortly."\n\n`;
    } else {
      const custom = ((config as any).messagingHandoffMessage || '').trim();
      if (custom) {
        prompt += `- You CANNOT take messages, pass details to the team, or arrange callbacks — no one is available over chat. If the customer wants a human, to leave a message, or a callback, do NOT offer to; instead reply with this exact message: "${custom}". You can still answer their questions and book them in.\n\n`;
      } else {
        const esc = [config.phoneNumber ? `phone ${config.phoneNumber}` : '', config.emailAddress ? `email ${config.emailAddress}` : ''].filter(Boolean).join(' or ');
        prompt += `- You CANNOT take messages, pass details to the team, or arrange callbacks — no one is available over chat. If the customer wants to speak to a human, leave a message, or asks for a callback, do NOT offer to; instead tell them to contact us directly${esc ? ` on ${esc}` : ''}. You can still answer their questions and book them in.\n\n`;
      }
    }

    // Active session context — mirrors Tyresoft, listing anything already
    // captured so the LLM stops re-asking. This is by far the most impactful
    // section for perceived quality on multi-turn chats.
    const hasSessionState =
      !!(session.vrm ||
        session.customerName ||
        session.customerPhone ||
        session.customerEmail ||
        session.selectedServiceIds.length ||
        session.selectedSlot ||
        session.bookingConfirmed ||
        session.existingBookingRef);
    if (hasSessionState) {
      prompt += `ACTIVE SESSION (do NOT ask for information already listed here):\n`;
      if (session.customerName)  prompt += `- Customer name: ${session.customerName} — already collected, do NOT ask again\n`;
      if (session.customerPhone) prompt += `- Customer phone: ${session.customerPhone} — already collected, do NOT ask again\n`;
      if (session.customerEmail) prompt += `- Customer email: ${session.customerEmail} — already collected, do NOT ask again\n`;
      if (session.vrm) {
        let line = `- Vehicle reg: ${session.vrm}`;
        if (session.vehicle?.make) line += ` (${session.vehicle.make} ${session.vehicle.model || ''})`.trimEnd();
        line += ' — do NOT call bk_lookup_vehicle again';
        prompt += `${line}\n`;
      }
      if (session.vehicle?.motExpiry) {
        prompt += `- MOT expires: ${session.vehicle.motExpiry}\n`;
      }
      if (session.selectedServiceIds.length && session.servicesOptions) {
        const names = session.selectedServiceIds
          .map((id) => session.servicesOptions!.find((s) => s.id === id)?.name || `id ${id}`)
          .join(', ');
        prompt += `- Service(s) chosen: ${names} (IDs: ${session.selectedServiceIds.join(', ')})\n`;
      }
      if (session.selectedSlot) {
        prompt += `- Slot chosen: ${session.selectedSlot.date} at ${normaliseTime(session.selectedSlot.time)} — do NOT ask again\n`;
      }
      if (session.availabilityOptions?.length && !session.selectedSlot) {
        const flat = flattenAvailability(session.availabilityOptions).slice(0, 5);
        const summary = flat.map((s) => `${s.date} ${s.time}`).join(', ');
        if (summary) prompt += `- Available slots already fetched (${summary}) — do NOT call bk_list_availability again unless the customer rejects them all\n`;
      }
      if (session.existingBookingRef && !session.bookingConfirmed) {
        prompt += `- Managing existing booking: ${session.existingBookingRef}\n`;
      }
      if (session.bookingConfirmed && session.bookingReference) {
        prompt += `- Booking already confirmed: ${session.bookingReference} (${session.bookingDetails || ''}) — do NOT call bk_create_booking again\n`;
      }
      prompt += `\n`;
    }
  } else {
    // No creds → agent can still handle general questions + take messages,
    // but must redirect for actual bookings.
    const phone = config.phoneNumber ? ` (${config.phoneNumber})` : '';
    const web   = config.websiteUrl  ? ` at ${config.websiteUrl}`  : '';
    prompt += `\nFor bookings, please direct customers to call us${phone} or visit our website${web}.\n\n`;
  }

  prompt += `STYLE: Warm, natural, and human. Keep it short — one sentence unless more detail is needed. Avoid corporate language.\n`;

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
