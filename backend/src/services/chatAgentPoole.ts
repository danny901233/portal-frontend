/**
 * Poole (AutoSage) chat agent — text/chat counterpart for garages using
 * Poole Software's booking API. Mirrors chatAgentBookar.ts closely: same
 * session cache TTL / DB fallback shape, same tool-loop pattern, same
 * server-side guardrails to stop the LLM inventing IDs.
 *
 * Key differences from Bookar:
 *   - Auth: single per-branch API key via `Key:` header (see pooleApi.ts).
 *     No OAuth2 token cache; we call the API helpers directly per tool.
 *   - Booking is a TWO-STAGE flow: create draft (B1) → add services (B3) →
 *     list slots (B4) → reserve slot (B5) → confirm (B6). Bookar creates the
 *     whole booking in one shot. We keep the draft `bookingRef` in session
 *     and use it as the pivot for B2-B6.
 *   - Prices are per-branch matrix pricing (returned by B2 against a draft),
 *     not per-vehicle. But same rule: NEVER quote a price without a live
 *     B2 call — never invent, never carry across sessions.
 *   - Confirm requires ONLY `customer.lastName` + `vehicle.registration`;
 *     other fields optional. We still ask for phone + email for the garage's
 *     records but the API won't reject a confirm without them.
 *   - Drafts expire in 4h — TTL logic uses the SAME warm-resume window (8h)
 *     as Bookar, but a draft `bookingRef` that's more than ~3.5h old will be
 *     rebuilt from scratch to avoid confirming into a dead draft.
 *   - Idempotency: `callReference` (dedupe key) is derived from conversationId
 *     + attempt counter, so a mid-flight retry re-uses the same draft.
 *
 * OpenAI GPT-4o (same as all other chat agents — do not swap to Claude).
 */
import { prisma } from '../db.js';
import { notifyMessaging } from './messagingNotifications.js';
import OpenAI from 'openai';
import { logChatToolCall } from './chatToolLog.js';
import { notifyFlaggedConversation } from '../utils/push.js';
import {
  findCustomerByPhone,
  lookupVehicleByVrm,
  createDraftBooking,
  listServices,
  addServicesToBooking,
  listAvailableSlots,
  reserveSlot,
  confirmBooking,
  rescheduleBooking,
  cancelBooking,
  getBooking,
  getBranches,
  PooleError,
  PooleAuthError,
  PooleService,
  PooleSlotDay,
  PooleCustomer,
  PooleVehicle,
} from './pooleApi.js';

// Lazy OpenAI client (same pattern as Bookar / Tyresoft).
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
// Session state — persisted to ChatConversation.sessionState (JSONB)
// ---------------------------------------------------------------------------
//
// Same 2h in-memory + 8h DB warm-resume as Bookar. Extra field on top of the
// Bookar shape: `bookingRef` (Poole draft ref, valid ~4h) — this is the
// pivot for B2-B6 and is separate from `bookingReference` (the human-
// readable job number returned by B6 confirm).
interface PooleSessionState {
  // Contact
  customerId?: number;              // Poole customer.customerId if found via A1
  customerName: string;
  customerPhone: string;
  customerEmail: string;            // optional for confirm but we ask for it

  // Vehicle
  vrm: string;                      // cleaned (uppercase, no spaces)
  vehicle?: {
    make?: string;
    model?: string;
    mileage?: number;
    motDueDate?: string;
    onFile: boolean;                // true if Poole already had this vehicle
  };

  // Services + slot
  servicesOptions?: PooleService[]; // last B2 result — never invent prices
  selectedServiceIds: number[];     // service_ids added to draft via B3
  availabilityOptions?: PooleSlotDay[];  // last B4 result, for slot cross-check
  selectedSlot?: { date: string; time: string };  // customer-picked, reserved via B5

  // Draft + confirmed booking
  bookingRef?: string;              // Poole draft ref (4h expiry)
  bookingRefCreatedAt?: string;     // ISO — used to detect stale drafts
  bookingRefAttempt?: number;       // increments on each rebuild for callReference dedupe
  bookingConfirmed: boolean;
  bookingReference?: string;        // job number returned by B6 (numeric, quoted to caller)
  bookingDetails?: string;          // human-readable summary

  // Manage-existing flow (caller quoted a reference)
  existingBookingRef?: string;      // Poole bookingRef when the caller quotes a job

  // Fallback
  lastTakeMessage?: string;

  // Housekeeping
  sessionUpdatedAt?: string;
}

function emptySessionState(): PooleSessionState {
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
// Session cache — 2h in-memory TTL, 8h DB warm-resume (matches Bookar/V2)
// ---------------------------------------------------------------------------
const IN_MEMORY_TTL_MS = 2 * 60 * 60 * 1000;  // 2 hours
const WARM_RESUME_MS   = 8 * 60 * 60 * 1000;  // 8 hours
const DRAFT_MAX_AGE_MS = 3.5 * 60 * 60 * 1000; // Poole drafts expire after 4h; rebuild at 3.5h to be safe

interface CachedSession {
  state: PooleSessionState;
  loadedAt: number;
}
const pooleSessions = new Map<string, CachedSession>();

async function loadSession(conversationId: string): Promise<PooleSessionState> {
  const hit = pooleSessions.get(conversationId);
  if (hit && Date.now() - hit.loadedAt < IN_MEMORY_TTL_MS) {
    return hit.state;
  }

  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ sessionState: any }>>(
      `SELECT "sessionState" FROM "ChatConversation" WHERE id = $1`,
      conversationId,
    );
    if (rows.length > 0 && rows[0].sessionState) {
      const raw = rows[0].sessionState as PooleSessionState & { sessionUpdatedAt?: string };
      const updatedAtIso = raw.sessionUpdatedAt;
      const ageMs = updatedAtIso ? Date.now() - new Date(updatedAtIso).getTime() : 0;
      if (ageMs > WARM_RESUME_MS) {
        console.log(
          `[POOLE_AGENT] Session for ${conversationId} expired (${Math.round(ageMs / 60000)}min) — starting fresh`,
        );
        const fresh = emptySessionState();
        pooleSessions.set(conversationId, { state: fresh, loadedAt: Date.now() });
        return fresh;
      }
      const state: PooleSessionState = { ...emptySessionState(), ...raw };

      // Draft-freshness guard: if the Poole draft ref is older than 3.5h, drop
      // it (the API will 404/410 on it anyway; better to rebuild cleanly).
      if (state.bookingRef && state.bookingRefCreatedAt) {
        const draftAge = Date.now() - new Date(state.bookingRefCreatedAt).getTime();
        if (draftAge > DRAFT_MAX_AGE_MS) {
          console.log(
            `[POOLE_AGENT] Draft ${state.bookingRef} for ${conversationId} is stale (${Math.round(draftAge / 60000)}min) — dropping so it rebuilds`,
          );
          state.bookingRef = undefined;
          state.bookingRefCreatedAt = undefined;
          // Keep the attempt counter — next rebuild bumps it for a fresh callReference.
          // Force B2/B4 to re-run against the new draft:
          state.servicesOptions = undefined;
          state.availabilityOptions = undefined;
        }
      }

      pooleSessions.set(conversationId, { state, loadedAt: Date.now() });
      return state;
    }
  } catch (e: any) {
    console.error(`[POOLE_AGENT] Failed to load sessionState for ${conversationId}:`, e?.message);
  }

  const fresh = emptySessionState();
  pooleSessions.set(conversationId, { state: fresh, loadedAt: Date.now() });
  return fresh;
}

async function saveSession(conversationId: string, state: PooleSessionState): Promise<void> {
  const toStore: PooleSessionState = {
    ...state,
    sessionUpdatedAt: new Date().toISOString(),
  };
  pooleSessions.set(conversationId, { state: toStore, loadedAt: Date.now() });

  try {
    const json = JSON.stringify(toStore);
    await prisma.$executeRawUnsafe(
      `UPDATE "ChatConversation" SET "sessionState" = $1::jsonb WHERE id = $2`,
      json,
      conversationId,
    );
  } catch (e: any) {
    console.error(`[POOLE_AGENT] saveSession failed for ${conversationId}:`, e?.message);
  }
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

// Poole slot times come back as "HH:mm" already; keep this helper for symmetry
// with Bookar and to guard against any future "HH:mm:ss" drift.
function normaliseTime(t: string): string {
  if (!t) return t;
  return t.length >= 5 ? t.slice(0, 5) : t;
}

function fmtMoney(n: number): string {
  return `£${n.toFixed(2)}`;
}

function normalisePhone(p: string): string {
  if (!p) return '';
  const trimmed = p.trim();
  if (trimmed.startsWith('+')) return '+' + trimmed.slice(1).replace(/[^\d]/g, '');
  return trimmed.replace(/[^\d]/g, '');
}

// Split a full display name into first + last. Poole confirm REQUIRES lastName
// (per handover doc §4 B6). If we only have one name part, return empty
// lastName so the caller can prompt for the surname instead of writing junk
// data into Poole's CRM. Mirrors chatAgentBookar which returns undefined for
// missing optional fields rather than duplicating firstName.
function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = String(fullName || '').trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

// ---------------------------------------------------------------------------
// Poole creds resolver
// ---------------------------------------------------------------------------
//
// Reads per-garage creds from integrationProviderConfig.pooleSettings, with
// env-var fallback (POOLE_API_KEY / POOLE_BRANCH_CODE) for local dev before
// the UI is populated. Nested + flat shapes both supported for symmetry with
// how Bookar and Tyresoft read their creds.
interface PooleCreds {
  branchKey: string;
  branchCode?: string;
}

function resolvePooleCreds(integrationProviderConfig: unknown): PooleCreds | null {
  const raw = (integrationProviderConfig && typeof integrationProviderConfig === 'object')
    ? (integrationProviderConfig as Record<string, unknown>)
    : {};
  const src = ((raw.poole as Record<string, unknown>) || (raw.pooleSettings as Record<string, unknown>) || raw) as Record<string, unknown>;
  const branchKey = String(src.branchKey || src.pooleBranchKey || process.env.POOLE_API_KEY || '').trim();
  const branchCode = String(src.branchCode || src.pooleBranchCode || process.env.POOLE_BRANCH_CODE || '').trim() || undefined;
  if (!branchKey) return null;
  return { branchKey, branchCode };
}

// ---------------------------------------------------------------------------
// Draft-booking bootstrapper
// ---------------------------------------------------------------------------
//
// Poole's flow requires a `bookingRef` before any of B2-B6 will work. We
// bootstrap one lazily the first time the agent needs to list services or
// check availability. `callReference` is `poole-chat-<conversationId>-<attempt>`
// so a fresh conversation gets a fresh booking, but a mid-turn retry within
// the same attempt re-uses the existing draft (via Poole's dedupe on callRef).
async function ensureDraft(
  session: PooleSessionState,
  conversationId: string,
  creds: PooleCreds,
): Promise<string> {
  if (session.bookingRef) return session.bookingRef;

  const attempt = (session.bookingRefAttempt ?? 0) + 1;
  const callReference = `poole-chat-${conversationId}-${attempt}`.slice(0, 100);
  const { bookingRef } = await createDraftBooking(
    creds.branchKey,
    callReference,
    creds.branchCode,
    /* notes */ session.customerName ? `Chat with ${session.customerName}` : undefined,
  );
  session.bookingRef = bookingRef;
  session.bookingRefCreatedAt = new Date().toISOString();
  session.bookingRefAttempt = attempt;
  await saveSession(conversationId, session);
  console.log(`[POOLE_AGENT] Draft created: ${bookingRef} (callRef=${callReference})`);
  return bookingRef;
}

// ---------------------------------------------------------------------------
// Main entry — mirrors getBookarChatResponse signature
// ---------------------------------------------------------------------------

export async function getPooleChatResponse(
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
        knowledgeDocuments: {
          orderBy: { updatedAt: 'desc' },
          take: 10,
        },
      },
    });

    if (!garage?.agentConfiguration) throw new Error('Garage configuration not found');
    const config = garage.agentConfiguration;

    const creds = resolvePooleCreds(config.integrationProviderConfig);
    const hasCreds = !!creds;

    console.log('[POOLE_AGENT] Config loaded:', {
      garageId,
      hasCreds,
      branchCode: creds?.branchCode || null,
      conversationId,
    });

    const isOpen = checkOpeningHours(config.weeklyOpeningHours);
    const session = await loadSession(conversationId);

    // Seed session from caller-id on first turn.
    if (seedContact) {
      if (seedContact.phone && !session.customerPhone) {
        session.customerPhone = normalisePhone(seedContact.phone);
      }
      if (seedContact.name && !session.customerName) {
        session.customerName = seedContact.name;
      }
    }

    // callerRecognitionEnabled toggle — if false, do NOT auto-look-up the
    // customer by phone even when we have a seed. Matches Bookar's convention
    // (default ON; explicitly off suppresses A1 tool exposure). Users can
    // still book without recognition, we just don't proactively query.
    const callerRecognition = (config as any).callerRecognitionEnabled !== false;

    // messagingHumanHandoff toggle — default ON, filter out handoff tools if false.
    const messagingHandoff = (config as any).messagingHumanHandoff !== false;
    let tools = buildTools(hasCreds, callerRecognition);
    if (!messagingHandoff) {
      tools = tools.filter(
        (t) => !['pl_take_message', 'pl_request_callback'].includes((t as any).function?.name),
      );
    }

    const sysPrompt = buildSystemPrompt(
      config,
      garage.knowledgeDocuments,
      isOpen,
      session,
      hasCreds,
      callerRecognition,
      messagingHandoff,
    );

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

    let userContent = message;
    if (seedContact && previousMessages.length === 0) {
      const hints: string[] = [];
      if (seedContact.name)  hints.push(`[Customer name: ${seedContact.name}]`);
      if (seedContact.phone) hints.push(`[Customer phone: ${seedContact.phone}]`);
      if (hints.length) userContent = `${hints.join(' ')} ${message}`;
    }
    messages.push({ role: 'user', content: userContent });

    // Cooler in booking flow — matches Bookar rule of thumb.
    const inBookingFlow =
      session.selectedServiceIds.length > 0 || !!session.selectedSlot || !!session.bookingRef;
    const temperature = inBookingFlow ? 0.5 : 0.9;

    let response = await getOpenAI().chat.completions.create({
      model: 'gpt-4o',
      messages,
      temperature,
      max_tokens: 250,
      tools,
      tool_choice: 'auto',
    });

    // Tool-call loop capped at 6 (one more than Bookar because Poole has a
    // two-stage draft+add-services pattern that legitimately runs more tools
    // per turn).
    let iterations = 0;
    while (response.choices[0]?.finish_reason === 'tool_calls' && iterations < 6) {
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
            `[POOLE_AGENT] Failed to parse tool args for ${call.function.name}:`,
            call.function.arguments,
          );
          args = {};
        }
        console.log(`[POOLE_AGENT] Tool call: ${call.function.name}`, args);

        const t0 = Date.now();
        const result = await executeTool(call.function.name, args, conversationId, garageId, creds);
        logChatToolCall({
          conversationId,
          garageId,
          agentType: 'poole',
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

    // Persist latest session state (some tool may have mutated it).
    const latest = pooleSessions.get(conversationId)?.state ?? session;
    await saveSession(conversationId, latest);

    return { content, needsHumanAssistance: false };
  } catch (error) {
    console.error('[POOLE_AGENT] Error:', error);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

function buildTools(
  hasCreds: boolean,
  callerRecognition: boolean,
): OpenAI.Chat.ChatCompletionTool[] {
  // Always-on: handoff tools (filtered later by messagingHumanHandoff toggle).
  const tools: OpenAI.Chat.ChatCompletionTool[] = [
    {
      type: 'function',
      function: {
        name: 'pl_take_message',
        description:
          "Hand the customer to a human. ONLY use this when EITHER the customer explicitly asks to speak to a human, OR they make a request you genuinely cannot handle from your knowledge and tools (e.g. wants a service Poole doesn't list, complaint, chasing a car already in the shop, out-of-scope). Do NOT use it for questions you can answer or bookings you can make yourself. Call it after collecting their message and phone number.",
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
    {
      type: 'function',
      function: {
        name: 'pl_request_callback',
        description:
          'Log a callback request when the customer explicitly asks to be called back rather than booking now. Distinct from pl_take_message — use this specifically when the customer says "can someone call me?" or prefers a phone callback.',
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
  ];

  if (!hasCreds) return tools;

  // Booking-capable tools (Poole creds present). Names are `pl_*` for clarity.
  if (callerRecognition) {
    tools.push({
      type: 'function',
      function: {
        name: 'pl_find_customer_by_phone',
        description:
          "Look up an existing customer by their phone number. Call this ON THE FIRST TURN if you know the customer's phone (from the seed contact hint). If a match is returned you get their name + linked vehicles — greet them naturally and skip re-collecting basics.",
        parameters: {
          type: 'object',
          properties: {
            phone: { type: 'string', description: 'Customer phone number' },
          },
          required: ['phone'],
        },
      },
    });
  }

  tools.push(
    {
      type: 'function',
      function: {
        name: 'pl_lookup_vehicle',
        description:
          'Look up a vehicle by registration plate. Returns make/model/mileage/MOT-due-date + whether the vehicle is on file. Prices in Poole are per-branch matrix (not per-vehicle) so this is optional before pl_list_services — but calling it lets you greet the caller naturally with the vehicle detail.',
        parameters: {
          type: 'object',
          properties: {
            registration: { type: 'string', description: 'Vehicle registration number, e.g. AB12 CDE' },
          },
          required: ['registration'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'pl_list_services',
        description:
          "List services + REAL prices for this branch. This tool lazily creates a Poole draft booking on the first call for this conversation, then returns the branch's service list with prices in GBP. NEVER invent, estimate or carry over a price from memory — always quote from this list. If the caller asks for a service NOT in the returned list, do NOT invent it — fall back to pl_take_message.",
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'pl_add_services',
        description:
          "Add the customer's chosen services to the draft booking. Poole REPLACES the current selection with what you send, so always include the full desired set. Call as soon as the customer picks services from pl_list_services and BEFORE pl_list_availability (Poole rejects slot lookups on a draft with no services).",
        parameters: {
          type: 'object',
          properties: {
            service_ids: {
              type: 'array',
              items: { type: 'number' },
              description: 'Poole serviceId values from pl_list_services',
            },
          },
          required: ['service_ids'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'pl_list_availability',
        description:
          "Fetch the next available slots for the draft's current services. Call ONLY after pl_add_services. Defaults date range to today → today+7 if unspecified. Offer only 1-2 slot options at a time — don't dump the whole list. Days with no availability are omitted from the response.",
        parameters: {
          type: 'object',
          properties: {
            date_from: { type: 'string', description: 'Earliest date to search (YYYY-MM-DD). Optional; defaults to today.' },
            date_to:   { type: 'string', description: 'Latest date to search (YYYY-MM-DD). Optional; defaults to today+7 (Poole max window is 14 days).' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'pl_confirm_slot',
        description:
          "Reserve the customer's chosen date + time on the draft (soft hold). Call as soon as the customer picks a slot from pl_list_availability. This is a soft reservation — if the slot goes at confirm time, Poole returns 409 and you re-list slots and pick again.",
        parameters: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'Slot date YYYY-MM-DD, exactly as returned by pl_list_availability' },
            time: { type: 'string', description: 'Slot time HH:MM 24-hour, exactly as returned by pl_list_availability' },
          },
          required: ['date', 'time'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'pl_save_customer_details',
        description:
          "Save the customer's name, phone and email into the session. Poole's booking confirmation REQUIRES a last name — everything else is optional but we still ask so the garage has full details. Call as soon as you have any subset; you can call it again to add missing pieces.",
        parameters: {
          type: 'object',
          properties: {
            name:  { type: 'string', description: 'Full name of the customer' },
            phone: { type: 'string', description: 'UK phone number of the customer' },
            email: { type: 'string', description: 'Email address (optional but recommended)' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'pl_create_booking',
        description:
          "Confirm the Poole draft booking (finalises it). Idempotent — safe to retry. ONLY call after the customer has said YES to the read-back summary AND you have: a draft (auto-created by pl_list_services), a reg (via pl_lookup_vehicle or asked directly), services (via pl_add_services), a slot reserved (via pl_confirm_slot), and at least a last name (via pl_save_customer_details).",
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'pl_retrieve_booking',
        description:
          "Retrieve an existing booking by its Poole bookingRef. Call when a caller quotes a reference (Poole bookingRef is a UUID) and wants to check, change or cancel — you MUST fetch the current state before offering to reschedule/cancel so we don't act on stale info.",
        parameters: {
          type: 'object',
          properties: {
            booking_ref: { type: 'string', description: 'The Poole bookingRef the customer quoted (UUID form)' },
          },
          required: ['booking_ref'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'pl_reschedule',
        description:
          "Reschedule an existing booking to a new date + time. Requires the Poole bookingRef (either the one the caller quoted, or the one from the booking we just created). You MUST have called pl_list_availability first so we're moving to a real available slot. Unavailable new slot returns an error and the ORIGINAL slot is preserved.",
        parameters: {
          type: 'object',
          properties: {
            booking_ref: { type: 'string', description: 'The Poole bookingRef to reschedule' },
            date:        { type: 'string', description: 'New date YYYY-MM-DD, exactly as returned by pl_list_availability' },
            time:        { type: 'string', description: 'New time HH:MM 24-hour, exactly as returned by pl_list_availability' },
          },
          required: ['booking_ref', 'date', 'time'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'pl_cancel',
        description:
          'Cancel an existing booking with a short reason. ONLY call after the customer has explicitly confirmed they want to cancel — never assume. Idempotent (cancelling an already-cancelled booking returns success). Completed/invoiced jobs cannot be cancelled through this API.',
        parameters: {
          type: 'object',
          properties: {
            booking_ref: { type: 'string', description: 'The Poole bookingRef to cancel' },
            reason:      { type: 'string', description: "Short reason string, e.g. 'customer request', 'vehicle sold', 'no longer needed'" },
          },
          required: ['booking_ref', 'reason'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'pl_get_branches',
        description:
          'Retrieve the branch this API key is scoped to (including opening hours and closed days). Rarely needed at runtime — mostly a diagnostic tool to verify the key is live and to confirm branch details if the caller asks.',
        parameters: { type: 'object', properties: {} },
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
  creds: PooleCreds | null,
): Promise<any> {
  const session = await loadSession(conversationId);

  try {
    switch (name) {
      // ── Human handoff (always available) ──────────────────────────────
      case 'pl_take_message': {
        const msg   = String(args.message || '').trim();
        const phone = normalisePhone(String(args.phone || ''));
        console.log(`[POOLE_AGENT] Take message: phone=${phone}, message=${msg}`);
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
          console.log(`[POOLE_AGENT] Conversation ${conversationId} flagged as needsAttention`);
        }
        return {
          success: true,
          message: 'Message taken. The team has been notified and will get back to you shortly.',
        };
      }

      case 'pl_request_callback': {
        const nm    = String(args.name  || '').trim();
        const phone = normalisePhone(String(args.phone || ''));
        const notes = String(args.notes || '').trim();
        console.log(`[POOLE_AGENT] [CALLBACK REQUEST] ${JSON.stringify({
          timestamp: new Date().toUTCString(),
          channel: 'chat',
          name: nm,
          phone,
          notes,
        })}`);
        if (nm)    session.customerName  = nm;
        if (phone) session.customerPhone = phone;
        await saveSession(conversationId, session);

        if (conversationId) {
          await prisma.chatConversation.updateMany({
            where: { id: conversationId },
            data: {
              needsAttention: true,
              agentPaused: true,
              ...(nm    ? { customerName:  nm    } : {}),
              ...(phone ? { customerPhone: phone } : {}),
            },
          });
          void notifyFlaggedConversation(conversationId);
          void notifyMessaging({ conversationId, event: 'escalated' });
        }
        return { success: true, message: 'Callback request logged.' };
      }

      // ── Poole-backed tools (need creds from here on) ───────────────────
      case 'pl_find_customer_by_phone': {
        if (!creds) return { error: 'Poole API not configured for this garage' };
        const phone = normalisePhone(String(args.phone || session.customerPhone || ''));
        if (!phone) return { found: false, message: 'No phone number provided.' };
        const matches = await findCustomerByPhone(creds.branchKey, phone);
        if (!matches.length) {
          console.log(`[POOLE_AGENT] findCustomerByPhone: no match for ${phone}`);
          return { found: false };
        }
        const cust: PooleCustomer = matches[0];
        session.customerId = cust.customerId;
        if (cust.name && !session.customerName) session.customerName = String(cust.name);
        if (cust.email && !session.customerEmail) session.customerEmail = String(cust.email);
        // Prefer mobile then telephone if we don't already have a phone captured.
        if ((cust.mobile || cust.telephone) && !session.customerPhone) {
          session.customerPhone = normalisePhone(String(cust.mobile || cust.telephone || ''));
        }
        await saveSession(conversationId, session);
        console.log(
          `[POOLE_AGENT] findCustomerByPhone: matched id=${cust.customerId} name=${cust.name || '(unknown)'} vehicles=${cust.vehicles?.length ?? 0}`,
        );
        return {
          found: true,
          customer_id: cust.customerId,
          name: cust.name || undefined,
          email: cust.email,
          phone: cust.mobile || cust.telephone,
          vehicles: (cust.vehicles || []).map((v) => ({
            registration: v.registration,
            make: toTitleCase(v.make || ''),
            model: toTitleCase(v.model || ''),
          })),
        };
      }

      case 'pl_lookup_vehicle': {
        if (!creds) return { error: 'Poole API not configured for this garage' };
        const reg = cleanVrm(String(args.registration || ''));
        if (!reg) return { error: 'registration required' };
        const vehicle = await lookupVehicleByVrm(creds.branchKey, reg);
        if (!vehicle) {
          // 404 → unknown reg. Persist just the VRM so the LLM can continue
          // (Poole confirm accepts a bare registration for unknown vehicles).
          session.vrm = reg;
          session.vehicle = { onFile: false };
          await saveSession(conversationId, session);
          console.log(`[POOLE_AGENT] lookupVehicleByVrm: 404 for ${reg} — captured VRM without detail`);
          return {
            found: false,
            registration: reg,
            note: 'Vehicle not on file in Poole — you can still take the booking; just confirm the make/model with the caller.',
          };
        }
        const make  = toTitleCase(vehicle.make  || '');
        const model = toTitleCase(vehicle.model || '');
        session.vrm = reg;
        session.vehicle = {
          make,
          model,
          mileage: vehicle.mileage ?? undefined,
          motDueDate: vehicle.motDueDate ?? undefined,
          onFile: true,
        };
        await saveSession(conversationId, session);
        console.log(
          `[POOLE_AGENT] lookupVehicleByVrm OK: ${reg} → ${make} ${model} mot=${vehicle.motDueDate || 'n/a'}`,
        );
        return {
          registration: reg,
          make,
          model,
          colour: vehicle.colour,
          mileage: vehicle.mileage,
          mot_due_date: vehicle.motDueDate,
          on_file: true,
          customer_name: vehicle.customerName,
        };
      }

      case 'pl_list_services': {
        if (!creds) return { error: 'Poole API not configured for this garage' };
        // Bootstrap a draft if we don't have one yet.
        const ref = await ensureDraft(session, conversationId, creds);
        const services = await listServices(creds.branchKey, ref);
        session.servicesOptions = services;
        await saveSession(conversationId, session);
        console.log(`[POOLE_AGENT] listServices: ref=${ref}, count=${services.length}`);
        return {
          count: services.length,
          services: services.map((s) => ({
            id: s.serviceId,
            code: s.code,
            description: s.description,
            price: fmtMoney(s.price ?? 0),
            price_numeric: s.price ?? 0,
            duration_minutes: s.durationMinutes,
          })),
        };
      }

      case 'pl_add_services': {
        if (!creds) return { error: 'Poole API not configured for this garage' };
        const serviceIds: number[] = Array.isArray(args.service_ids)
          ? args.service_ids.map(Number).filter(Boolean)
          : [];
        if (serviceIds.length === 0) {
          return { error: 'At least one service_id is required. Call pl_list_services first and pass the chosen ids.' };
        }
        // Cross-check ids against what listServices last returned.
        if (session.servicesOptions?.length) {
          const known = new Set(session.servicesOptions.map((s) => s.serviceId));
          const unknown = serviceIds.filter((id) => !known.has(id));
          if (unknown.length > 0) {
            return {
              error: 'unknown_service_id',
              directive: `Service id(s) ${unknown.join(', ')} were not in the last pl_list_services result. Re-check with the customer and pick from the real id list.`,
            };
          }
        }
        const ref = await ensureDraft(session, conversationId, creds);
        await addServicesToBooking(creds.branchKey, ref, serviceIds);
        session.selectedServiceIds = serviceIds;
        // Clear any previously-picked slot — the service set changed so
        // availability may have shifted.
        session.selectedSlot = undefined;
        session.availabilityOptions = undefined;
        await saveSession(conversationId, session);
        console.log(`[POOLE_AGENT] addServicesToBooking: ref=${ref}, ids=${serviceIds.join(',')}`);
        return { success: true, service_ids: serviceIds };
      }

      case 'pl_list_availability': {
        if (!creds) return { error: 'Poole API not configured for this garage' };
        if (!session.bookingRef) {
          return {
            error: 'no_draft',
            directive: 'Call pl_list_services first (it creates the draft) and then pl_add_services before checking availability.',
          };
        }
        if (session.selectedServiceIds.length === 0) {
          return {
            error: 'no_services',
            directive: 'Call pl_add_services with the customer\'s picked service ids before checking availability. Poole requires at least one service on the draft first.',
          };
        }
        const dateFrom = String(args.date_from || todayIso());
        const dateTo   = String(args.date_to   || addDaysIso(7));
        const days = await listAvailableSlots(creds.branchKey, session.bookingRef, dateFrom, dateTo);
        session.availabilityOptions = days;
        session.selectedSlot = undefined;
        await saveSession(conversationId, session);
        console.log(
          `[POOLE_AGENT] listAvailableSlots: ref=${session.bookingRef} ${dateFrom}→${dateTo} days=${days.length}`,
        );

        // Flatten into next 6 slots for the LLM (matches Bookar style).
        const flat: Array<{ date: string; time: string }> = [];
        for (const day of days) {
          for (const t of day.times || []) {
            flat.push({ date: day.date, time: normaliseTime(t) });
            if (flat.length >= 6) break;
          }
          if (flat.length >= 6) break;
        }
        return {
          count: flat.length,
          next_slots: flat,
          searched: { from: dateFrom, to: dateTo },
        };
      }

      case 'pl_confirm_slot': {
        if (!creds) return { error: 'Poole API not configured for this garage' };
        if (!session.bookingRef) {
          return { error: 'no_draft', directive: 'Start with pl_list_services + pl_add_services + pl_list_availability first.' };
        }
        const date = String(args.date || '').trim();
        const time = normaliseTime(String(args.time || '').trim());
        if (!date || !time) return { error: 'date and time both required' };

        // Cross-check against last availability result.
        const found = flattenSlots(session.availabilityOptions || []).find(
          (s) => s.date === date && s.time === time,
        );
        if (!found) {
          return {
            error: 'slot_not_available',
            directive: 'That date/time was not in the last pl_list_availability result. Call pl_list_availability again and pick from the returned slots.',
          };
        }

        try {
          await reserveSlot(creds.branchKey, session.bookingRef, date, time);
        } catch (e: any) {
          if (e instanceof PooleError && e.status === 409) {
            // Slot went while we were talking — clear + prompt re-list.
            session.availabilityOptions = undefined;
            await saveSession(conversationId, session);
            return {
              error: 'slot_unavailable',
              directive: 'That slot has just been taken. Call pl_list_availability again and offer fresh options.',
            };
          }
          throw e;
        }

        session.selectedSlot = { date, time };
        await saveSession(conversationId, session);
        console.log(`[POOLE_AGENT] Slot reserved: ${date} ${time}`);
        return { success: true, date, time };
      }

      case 'pl_save_customer_details': {
        const nm    = String(args.name  || '').trim();
        const phone = normalisePhone(String(args.phone || ''));
        const email = String(args.email || '').trim();
        if (nm)    session.customerName  = nm;
        if (phone) session.customerPhone = phone;
        if (email) session.customerEmail = email;
        await saveSession(conversationId, session);
        console.log(
          `[POOLE_AGENT] Customer details saved: name=${session.customerName}, phone=${session.customerPhone}, email=${session.customerEmail}`,
        );

        // Mirror to ChatConversation so name/phone show in the portal inbox.
        if (conversationId && (nm || phone)) {
          await prisma.chatConversation.updateMany({
            where: { id: conversationId },
            data: {
              ...(nm    ? { customerName:  nm    } : {}),
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

      case 'pl_create_booking': {
        if (!creds) return { error: 'Poole API not configured for this garage' };
        return await pooleConfirmDraft(session, conversationId, garageId, creds);
      }

      case 'pl_retrieve_booking': {
        if (!creds) return { error: 'Poole API not configured for this garage' };
        const ref = String(args.booking_ref || '').trim();
        if (!ref) return { error: 'booking_ref required' };
        const booking = await getBooking(creds.branchKey, ref);
        session.existingBookingRef = ref;
        await saveSession(conversationId, session);
        console.log(`[POOLE_AGENT] getBooking OK: ${ref} status=${booking.status}`);
        return {
          booking_ref: booking.bookingRef,
          reference: booking.reference,
          status: booking.status,
          branch_name: booking.branchName,
          date: booking.date,
          time: booking.time,
          end_time: booking.endTime,
          registration: booking.registration,
          customer_name: booking.customerName,
          total: booking.total,
          services: booking.services?.map((s) => ({
            id: s.serviceId,
            code: s.code,
            description: s.description,
            price: fmtMoney(s.price ?? 0),
          })),
        };
      }

      case 'pl_reschedule': {
        if (!creds) return { error: 'Poole API not configured for this garage' };
        const ref  = String(args.booking_ref || session.existingBookingRef || '').trim();
        const date = String(args.date || '').trim();
        const time = normaliseTime(String(args.time || '').trim());
        if (!ref || !date || !time) {
          return { error: 'booking_ref, date and time all required' };
        }
        const found = flattenSlots(session.availabilityOptions || []).find(
          (s) => s.date === date && s.time === time,
        );
        if (!found) {
          return {
            error: 'slot_not_available',
            directive: 'That date/time was not in the last pl_list_availability result. Call pl_list_availability again and pick from the returned slots.',
          };
        }
        try {
          await rescheduleBooking(creds.branchKey, ref, date, time);
        } catch (e: any) {
          if (e instanceof PooleError && e.status === 409) {
            session.availabilityOptions = undefined;
            await saveSession(conversationId, session);
            return {
              error: 'slot_unavailable',
              directive: 'That slot has just been taken; the original booking is unchanged. Call pl_list_availability again and offer fresh options.',
            };
          }
          throw e;
        }
        console.log(`[POOLE_AGENT] rescheduleBooking OK: ${ref} → ${date} ${time}`);
        return { success: true, booking_ref: ref, date, time };
      }

      case 'pl_cancel': {
        if (!creds) return { error: 'Poole API not configured for this garage' };
        const ref    = String(args.booking_ref || session.existingBookingRef || '').trim();
        const reason = String(args.reason || 'customer request').trim();
        if (!ref) return { error: 'booking_ref required' };
        await cancelBooking(creds.branchKey, ref, reason);
        console.log(`[POOLE_AGENT] cancelBooking OK: ${ref} reason=${reason}`);
        // If we just cancelled the booking we made this session, clear our state.
        if (session.bookingRef === ref || session.bookingReference === ref) {
          session.bookingConfirmed = false;
          session.bookingReference = undefined;
          session.bookingDetails = undefined;
          await saveSession(conversationId, session);
        }
        return { success: true, booking_ref: ref, reason };
      }

      case 'pl_get_branches': {
        if (!creds) return { error: 'Poole API not configured for this garage' };
        const branches = await getBranches(creds.branchKey);
        console.log(`[POOLE_AGENT] getBranches OK: ${branches.length} branch(es)`);
        return { count: branches.length, branches };
      }

      default:
        return { error: 'Unknown tool' };
    }
  } catch (error: any) {
    if (error instanceof PooleAuthError) {
      console.error(`[POOLE_AGENT] Auth error in ${name}:`, error.message);
      return {
        error: 'poole_auth_error',
        directive:
          'The garage credentials for the booking system are not working right now. Apologise briefly and use pl_take_message so the team can follow up.',
      };
    }
    if (error instanceof PooleError) {
      console.error(`[POOLE_AGENT] Poole API error in ${name}:`, error.message, error.body);
      return {
        error: 'poole_api_error',
        status: error.status,
        message: error.message,
        body: error.body,
        ...(error.retryAfterSeconds ? { retry_after_seconds: error.retryAfterSeconds } : {}),
      };
    }
    console.error(`[POOLE_AGENT] Tool error (${name}):`, error?.message || error);
    return { error: error?.message || 'Tool execution failed' };
  }
}

// Flatten day-grouped slots into a flat {date, time} list for cross-checks.
function flattenSlots(days: PooleSlotDay[]): Array<{ date: string; time: string }> {
  const flat: Array<{ date: string; time: string }> = [];
  for (const day of days) {
    for (const t of day.times || []) {
      flat.push({ date: day.date, time: normaliseTime(t) });
    }
  }
  return flat;
}

// ---------------------------------------------------------------------------
// Confirm the draft (B6) — the "commit" step that turns Pending → Booked
// ---------------------------------------------------------------------------

async function pooleConfirmDraft(
  session: PooleSessionState,
  conversationId: string,
  garageId: string,
  creds: PooleCreds,
): Promise<any> {
  // Preflight — bail with a directive the LLM can act on.
  if (!session.bookingRef) {
    return { error: 'no_draft', directive: 'Call pl_list_services first (creates the draft) before pl_create_booking.' };
  }
  if (!session.vrm) {
    return { error: 'no_vrm', directive: 'Ask for the plate and call pl_lookup_vehicle before confirming.' };
  }
  if (!session.selectedServiceIds.length) {
    return { error: 'no_services', directive: 'Call pl_list_services + pl_add_services with the customer\'s chosen ids first.' };
  }
  if (!session.selectedSlot) {
    return { error: 'no_slot', directive: 'Call pl_list_availability, offer slots, and call pl_confirm_slot once the customer picks one.' };
  }
  if (!session.customerName) {
    return { error: 'no_name', directive: 'Ask for the customer name and call pl_save_customer_details.' };
  }
  // Poole only REQUIRES lastName + registration. We ask for phone as best-practice
  // but confirm can proceed without it — reflect that here so the LLM doesn't
  // get stuck chasing an optional field.

  const { firstName, lastName } = splitName(session.customerName);
  if (!lastName) {
    // Poole confirm hard-requires lastName (handover §4 B6). Rather than fake it
    // by duplicating firstName (would write junk data into Poole's CRM), bounce
    // back to the LLM to ask for the surname explicitly. Same pattern as the
    // no_name / no_vrm / no_slot guards above.
    return {
      error: 'no_last_name',
      directive: 'We only have a first name. Ask the caller for their surname, then call pl_save_customer_details with the full name.',
    };
  }
  const customer = {
    firstName: firstName || null,
    lastName,
    mobile: session.customerPhone || null,
    email: session.customerEmail || null,
  };
  const vehicle = {
    registration: session.vrm,
    make:  session.vehicle?.make  || null,
    model: session.vehicle?.model || null,
  };

  let booking;
  try {
    booking = await confirmBooking(
      creds.branchKey,
      session.bookingRef,
      customer,
      vehicle,
      session.vehicle?.mileage,
    );
  } catch (e: any) {
    if (e instanceof PooleError && e.status === 409) {
      // Slot went between B5 and B6 — SLOT_UNAVAILABLE race. Clear + rewind.
      const bodyText = typeof e.body === 'string' ? e.body : JSON.stringify(e.body || {});
      console.error(`[POOLE_AGENT] confirmBooking 409 (likely SLOT_UNAVAILABLE): ${bodyText}`);
      session.selectedSlot = undefined;
      session.availabilityOptions = undefined;
      await saveSession(conversationId, session);
      return {
        error: 'slot_unavailable',
        directive: 'The slot went just as we tried to book it. Apologise briefly, call pl_list_availability again and pick a fresh slot.',
      };
    }
    if (e instanceof PooleError) {
      console.error(`[POOLE_AGENT] confirmBooking failed (status=${e.status}):`, e.body);
      return {
        error: 'booking_failed',
        status: e.status,
        details: e.body,
        message: e.message,
      };
    }
    console.error(`[POOLE_AGENT] confirmBooking failed:`, e?.message);
    return { error: 'booking_failed', message: e?.message };
  }

  // Human-readable summary for the ChatConversation inbox.
  const services = session.servicesOptions || [];
  const chosen = session.selectedServiceIds
    .map((id) => services.find((s) => s.serviceId === id))
    .filter((s): s is PooleService => !!s);
  const summary = chosen.length
    ? `${chosen.map((s) => s.code || s.description || `#${s.serviceId}`).join(', ')} on ${session.selectedSlot.date} at ${normaliseTime(session.selectedSlot.time)}`
    : `Booking on ${session.selectedSlot.date} at ${normaliseTime(session.selectedSlot.time)}`;
  const totalRevenue = booking.total ?? chosen.reduce((sum, s) => sum + (s.price ?? 0), 0);

  session.bookingConfirmed = true;
  // Store the human-quotable job number (booking.reference) here — this is
  // what the caller quotes back on a future call. bookingRef stays too, so
  // reschedule/cancel within the same session can use it.
  session.bookingReference = String(booking.reference ?? booking.bookingRef ?? '');
  session.bookingDetails = summary;
  await saveSession(conversationId, session);

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
    // Non-fatal — booking is live on Poole's side, just log.
    console.error(`[POOLE_AGENT] Failed to persist booking to ChatConversation:`, e?.message);
  }

  // Structured booking log — same shape as Bookar for cross-channel ops search.
  console.log(
    `[BOOKING CREATED] ${JSON.stringify({
      timestamp: new Date().toUTCString(),
      channel: 'chat',
      agent: 'poole',
      booking_ref: booking.bookingRef,
      reference: booking.reference,
      customer: session.customerName,
      phone: session.customerPhone,
      email: session.customerEmail,
      vrm: session.vrm,
      vehicle: session.vehicle ? `${session.vehicle.make || ''} ${session.vehicle.model || ''}`.trim() : '',
      services: chosen.map((s) => `${s.code || s.description || s.serviceId} (${fmtMoney(s.price ?? 0)})`).join(', '),
      date: session.selectedSlot.date,
      time: normaliseTime(session.selectedSlot.time),
      revenue: fmtMoney(totalRevenue),
      garageId,
    })}`,
  );

  return {
    success: true,
    booking_ref: booking.bookingRef,
    reference: booking.reference,
    status: booking.status,
    date: booking.date,
    time: booking.time,
    services: chosen.map((s) => s.code || s.description || `#${s.serviceId}`),
    total: fmtMoney(totalRevenue),
  };
}

// ---------------------------------------------------------------------------
// System prompt — same shape as chatAgentBookar's (persona → about → hours →
// knowledge → rules → booking flow → active session)
// ---------------------------------------------------------------------------

function buildSystemPrompt(
  config: any,
  knowledgeDocs: any[],
  isOpen: boolean,
  session: PooleSessionState,
  hasCreds: boolean,
  callerRecognition: boolean,
  humanEscalation: boolean,
): string {
  const branchName = config.branchName || 'our garage';
  const agentName = (config.agentName || '').trim();
  const who = agentName ? `${agentName}, a friendly receptionist` : 'a friendly receptionist';

  let prompt = `You are ${who} at ${branchName}, a UK vehicle service centre. ${config.greetingLine || ''}\n\n`;

  // Current date and time (London) — mirrors chatAgentBookar / V2 pattern.
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

  // Voice
  prompt += `HOW YOU TALK — like a real person texting, NOT an essay:\n`;
  prompt += `- Keep every reply to ONE short sentence. Never a paragraph — a real person wouldn't.\n`;
  prompt += `- Warm, natural, British English (tyre, kerb, MOT; "brilliant", "no worries", "cheers"). One question at a time.\n`;
  prompt += `- Money: write natural words, e.g. "fifty-four pounds eighty-five pence", not "£54.85".\n`;
  prompt += `- Dates: "the 12th of October", "Tuesday next week", not "2026-10-12".\n`;
  prompt += `- No lists or bullet points. No corporate filler ("Certainly!", "Of course!", "Great!"). Never sound like a bot.\n`;
  prompt += `- Never mention tool names or internal steps.\n\n`;

  // About us
  prompt += `About us:\n`;
  if (config.branchAddress) prompt += `Address: ${config.branchAddress}\n`;
  if (config.phoneNumber)   prompt += `Phone: ${config.phoneNumber}\n`;
  if (config.emailAddress)  prompt += `Email: ${config.emailAddress}\n`;
  if (config.websiteUrl)    prompt += `Website: ${config.websiteUrl}\n`;
  prompt += `\n`;

  // Opening hours
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

  // Knowledge docs
  if (knowledgeDocs.length) {
    prompt += `Additional info:\n`;
    for (const doc of knowledgeDocs) {
      if (doc.title) prompt += `${doc.title}:\n`;
      prompt += `${doc.content}\n\n`;
    }
  }

  // Per-garage custom rules / FAQs / data-collection fields.
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

  // Booking flow (only if creds are present).
  if (hasCreds) {
    prompt += `\nBOOKING FLOW — follow in order, one step per reply:\n\n`;

    if (callerRecognition) {
      prompt += `1. FIRST CONTACT: If you already know the customer's phone (from the seed contact hint at the top of their first message), call pl_find_customer_by_phone. If it returns found=true, greet them by name and acknowledge their linked vehicle(s) — do NOT re-ask for name if we got it back.\n`;
    } else {
      prompt += `1. FIRST CONTACT: Greet warmly and ask what they need — do NOT proactively look up the customer by phone.\n`;
    }
    prompt += `2. NAME: If we don't already have a name, ask for it in one short sentence.\n`;
    prompt += `3. REG: Ask for their vehicle registration. Once you have it, call pl_lookup_vehicle. Read back the make/model naturally, e.g. "I can see that's a 2019 Ford Focus — is that right?" If mot_due_date is present, weave it in naturally if relevant. If Poole doesn't have the vehicle on file (found=false), just carry on — the booking still works.\n`;
    prompt += `4. SERVICES: Call pl_list_services (this also creates the draft booking under the hood). Quote prices ONLY from the returned list — never invent, estimate or carry over a price from memory. If the customer asks for a service NOT in the returned list, do NOT invent it — apologise briefly and fall back to pl_take_message so the team can help.\n`;
    prompt += `5. ADD SERVICES: When the customer picks service(s), call pl_add_services with the chosen ids. Poole replaces the current selection each call — always send the FULL desired set. Do this BEFORE checking availability (Poole rejects slot lookups on a draft with no services).\n`;
    prompt += `6. AVAILABILITY: Call pl_list_availability. Offer 1 or 2 slots naturally — don't dump the whole list.\n`;
    prompt += `7. SLOT: When the customer picks a slot, IMMEDIATELY call pl_confirm_slot with the exact date + time from the availability result. This puts a soft hold on it.\n`;
    prompt += `8. CONTACT: Ask for a phone number and (optionally) an email, then call pl_save_customer_details. You need at least a last name to confirm — everything else is nice to have.\n`;
    prompt += `9. READ-BACK: Summarise the whole booking in ONE sentence — service, day, time, name. Ask "shall I confirm?"\n`;
    prompt += `10. CONFIRM: Only after an explicit yes, call pl_create_booking. NEVER say the booking is done before this tool has returned success. Read the returned \`reference\` (a numeric job number) back naturally, e.g. "You're all booked in — your reference is 2795. See you Tuesday at ten. Anything else?"\n\n`;

    prompt += `MANAGING EXISTING BOOKINGS:\n`;
    prompt += `- If the caller quotes a booking reference (Poole uses a UUID-style bookingRef): call pl_retrieve_booking FIRST so you're working from the current state.\n`;
    prompt += `- To move: call pl_list_availability, pl_confirm_slot on the new slot, then pl_reschedule with the booking_ref. Unavailable new slot → the original stays put.\n`;
    prompt += `- To cancel: get an explicit "yes I want to cancel" before calling pl_cancel. Never assume.\n\n`;

    prompt += `HARD RULES:\n`;
    prompt += `- NEVER quote a price without a live pl_list_services call in THIS conversation.\n`;
    prompt += `- NEVER claim a booking is confirmed until pl_create_booking has returned success.\n`;
    prompt += `- NEVER call pl_create_booking twice in one conversation. If a booking has already been confirmed (session.bookingReference is set) and the customer wants a different slot, use pl_reschedule with the existing booking_ref — do NOT create a second booking.\n`;
    prompt += `- NEVER re-run pl_lookup_vehicle for a VRM already captured in this session.\n`;
    prompt += `- NEVER ask for information already saved in the active session (see below).\n`;
    prompt += `- If the customer wants a service that isn't in the pl_list_services result, do NOT try to force it — use pl_take_message so a human can follow up.\n`;
    prompt += `- CRITICAL: When a customer provides their name, phone number, email or reg, do NOT greet them again or start over. Continue from where you left off.\n`;
    prompt += `- CRITICAL: If they give only their name and you still need phone/email, say "Thanks [name] — what's the best number to reach you on?" — do NOT say "Hello [name]! How can I assist you today?"\n`;
    prompt += `- Never use markdown: no **bold**, no bullets, no dashes. Plain sentences only.\n`;

    if (humanEscalation) {
      prompt += `- If the customer wants to speak to a human, or asks something you genuinely can't handle:\n`;
      prompt += `  Ask what their message is and confirm you have their phone number, then call pl_take_message and reply: "I've passed your message on to the team. Someone will get back to you shortly."\n`;
      prompt += `  Do NOT continue trying to help after pl_take_message — the conversation is handed off.\n`;
      prompt += `- If the customer explicitly asks to be called back:\n`;
      prompt += `  Get their name + best number if not already known, call pl_request_callback, then say: "No problem — I've logged a callback request and someone will give you a ring shortly."\n\n`;
    } else {
      const custom = ((config as any).messagingHandoffMessage || '').trim();
      if (custom) {
        prompt += `- You CANNOT take messages, pass details to the team, or arrange callbacks — no one is available over chat. If the customer wants a human, to leave a message, or a callback, do NOT offer to; instead reply with this exact message: "${custom}". You can still answer their questions and book them in.\n\n`;
      } else {
        const esc = [config.phoneNumber ? `phone ${config.phoneNumber}` : '', config.emailAddress ? `email ${config.emailAddress}` : ''].filter(Boolean).join(' or ');
        prompt += `- You CANNOT take messages, pass details to the team, or arrange callbacks — no one is available over chat. If the customer wants to speak to a human, leave a message, or asks for a callback, do NOT offer to; instead tell them to contact us directly${esc ? ` on ${esc}` : ''}. You can still answer their questions and book them in.\n\n`;
      }
    }

    // Active session — same UX-critical block as Bookar.
    const hasSessionState =
      !!(session.vrm ||
        session.customerName ||
        session.customerPhone ||
        session.customerEmail ||
        session.selectedServiceIds.length ||
        session.selectedSlot ||
        session.bookingConfirmed ||
        session.existingBookingRef ||
        session.bookingRef);
    if (hasSessionState) {
      prompt += `ACTIVE SESSION (do NOT ask for information already listed here):\n`;
      if (session.customerName)  prompt += `- Customer name: ${session.customerName} — already collected, do NOT ask again\n`;
      if (session.customerPhone) prompt += `- Customer phone: ${session.customerPhone} — already collected, do NOT ask again\n`;
      if (session.customerEmail) prompt += `- Customer email: ${session.customerEmail} — already collected, do NOT ask again\n`;
      if (session.vrm) {
        let line = `- Vehicle reg: ${session.vrm}`;
        if (session.vehicle?.make) line += ` (${session.vehicle.make} ${session.vehicle.model || ''})`.trimEnd();
        line += ' — do NOT call pl_lookup_vehicle again';
        prompt += `${line}\n`;
      }
      if (session.vehicle?.motDueDate) {
        prompt += `- MOT due: ${session.vehicle.motDueDate}\n`;
      }
      if (session.bookingRef && !session.bookingConfirmed) {
        prompt += `- Draft booking in progress (bookingRef: ${session.bookingRef}) — do NOT call pl_list_services or pl_add_services again unless service selection changes\n`;
      }
      if (session.selectedServiceIds.length && session.servicesOptions) {
        const names = session.selectedServiceIds
          .map((id) => {
            const s = session.servicesOptions!.find((x) => x.serviceId === id);
            return s ? (s.code || s.description || `id ${id}`) : `id ${id}`;
          })
          .join(', ');
        prompt += `- Service(s) chosen: ${names} (IDs: ${session.selectedServiceIds.join(', ')})\n`;
      }
      if (session.selectedSlot) {
        prompt += `- Slot reserved: ${session.selectedSlot.date} at ${normaliseTime(session.selectedSlot.time)} — do NOT ask again\n`;
      }
      if (session.availabilityOptions?.length && !session.selectedSlot) {
        const flat = flattenSlots(session.availabilityOptions).slice(0, 5);
        const summary = flat.map((s) => `${s.date} ${s.time}`).join(', ');
        if (summary) prompt += `- Available slots already fetched (${summary}) — do NOT call pl_list_availability again unless the customer rejects them all\n`;
      }
      if (session.existingBookingRef && !session.bookingConfirmed) {
        prompt += `- Managing existing booking: ${session.existingBookingRef}\n`;
      }
      if (session.bookingConfirmed && session.bookingReference) {
        prompt += `- Booking already confirmed: ${session.bookingReference} (${session.bookingDetails || ''}) — do NOT call pl_create_booking again\n`;
      }
      prompt += `\n`;
    }
  } else {
    // No creds — behave like the fallback path in Bookar: general Q&A + redirect
    // for bookings. Message-taking still available if the toggle is on.
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
