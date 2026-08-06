/**
 * Poole/AutoSage Booking Integration
 *
 * Sandbox: https://autosage-alpha-e6cucycjezh4guay.uksouth-01.azurewebsites.net
 *
 * Reference: /memory/POOLE_AUTOSAGE_IMPLEMENTATION_GUIDE.md
 * - All 11 endpoints (A1-A2, B1-B6, C1-C3, D1)
 * - Session state: bookingRef, callReference, selectedServiceIds, reservedSlot, draftExpiresAt
 * - Auth: API key in "Key" header (one per branch)
 * - Idempotency: callReference (client-managed, unique per call)
 * - Draft expiry: 4 hours
 */

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

// Poole configuration - loaded from garage config
interface PooleConfig {
  apiKey: string;
  branchCode: string;
  workspace?: string;
}

interface ChatAgentResponse {
  content: string;
  needsHumanAssistance?: boolean;
}

/**
 * Chat session state for Poole booking flow
 * Reference: POOLE_AUTOSAGE_IMPLEMENTATION_GUIDE.md § 4 (Session State Management)
 */
enum Step {
  GREETING = 'greeting',
  NEED_PHONE = 'need_phone',
  CONFIRMING_CUSTOMER = 'confirming_customer',
  NEED_VEHICLE = 'need_vehicle',
  CONFIRMING_VEHICLE = 'confirming_vehicle',
  NEED_SERVICE = 'need_service',
  CONFIRMING_SERVICE = 'confirming_service',
  NEED_SLOT = 'need_slot',
  CONFIRMING_SLOT = 'confirming_slot',
  NEED_CONTACT = 'need_contact',
  CONFIRMING_BOOKING = 'confirming_booking',
  CONFIRMED = 'confirmed',
  DONE = 'done',
  MESSAGE_ONLY = 'message_only',
}

interface ChatSession {
  step: Step;
  intent: string; // 'booking', 'message'

  // Poole API state (Reference: § 4)
  bookingRef: string;              // From B1: create_draft_booking()
  callReference: string;            // Unique per call (timestamp-based for idempotency)
  draftExpiresAt: number;          // Timestamp when draft auto-expires (now + 4 hours)
  selectedServiceIds: number[];    // From B3: add_services_to_booking()
  reservedDate: string;            // YYYY-MM-DD from B5: reserve_slot()
  reservedTime: string;            // HH:mm from B5: reserve_slot()

  // Customer lookup (A1)
  customerId?: number;
  customerName: string;
  knownVehicles: any[];

  // Vehicle (A2 / B6)
  registration: string;
  vehicleMake: string;
  vehicleModel: string;
  vehicleColour?: string;
  vehicleMileage?: number;
  motDueDate?: string;

  // Service selection (B2, B3)
  servicesAvailable: any[];         // From B2: list_services()
  serviceSelectedIds: number[];     // Currently selected
  serviceSelectedNames: string[];   // Display names

  // Slots (B4, B5)
  slotsAvailable: any[];           // From B4: list_available_slots()
  slotsShownDate?: string;         // Anchor bare time picks ("1pm") to the right date
  preferredDate?: string;          // Natural language date from customer

  // Contact (B6 confirm)
  contactFirstName: string;
  contactLastName: string;
  contactTitle?: string;
  contactMobile: string;
  contactEmail?: string;
  contactPhone?: string;

  // Diagnostics
  diagnosticNotes: string;
  message: string;
  preferredCallbackTime: string;

  // Confirmation response (B6)
  bookingConfirmation?: any;      // Full response from confirm_booking()
  jobReference?: string;          // Garage's human-readable job number
}

const inMemorySessionCache = new Map<string, ChatSession>();
const sessionLastAccessed = new Map<string, number>();
const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

setInterval(() => {
  const now = Date.now();
  for (const [id, lastAccessed] of sessionLastAccessed) {
    if (now - lastAccessed > SESSION_TTL_MS) {
      inMemorySessionCache.delete(id);
      sessionLastAccessed.delete(id);
    }
  }
}, 30 * 60 * 1000).unref(); // run every 30 min, don't block process exit

// Session storage - persist to database
async function getOrCreateSession(conversationId: string): Promise<ChatSession> {
  const cached = inMemorySessionCache.get(conversationId);
  if (cached) {
    sessionLastAccessed.set(conversationId, Date.now());
    return { ...cached };
  }

  // Load from DB
  const convo = await prisma.chatConversation.findUnique({
    where: { id: conversationId },
  });

  let session: ChatSession;
  if (convo?.sessionState && typeof convo.sessionState === 'object') {
    session = convo.sessionState as ChatSession;
  } else {
    session = createEmptySession();
  }

  inMemorySessionCache.set(conversationId, session);
  sessionLastAccessed.set(conversationId, Date.now());
  return { ...session };
}

function createEmptySession(): ChatSession {
  return {
    step: Step.GREETING,
    intent: 'booking',
    bookingRef: '',
    callReference: '',
    draftExpiresAt: 0,
    selectedServiceIds: [],
    reservedDate: '',
    reservedTime: '',
    customerId: undefined,
    customerName: '',
    knownVehicles: [],
    registration: '',
    vehicleMake: '',
    vehicleModel: '',
    serviceSelectedIds: [],
    serviceSelectedNames: [],
    servicesAvailable: [],
    slotsAvailable: [],
    contactFirstName: '',
    contactLastName: '',
    contactMobile: '',
    diagnosticNotes: '',
    message: '',
    preferredCallbackTime: '',
  };
}

async function saveSession(conversationId: string, session: ChatSession): Promise<void> {
  inMemorySessionCache.set(conversationId, session);
  sessionLastAccessed.set(conversationId, Date.now());

  await prisma.chatConversation.update({
    where: { id: conversationId },
    data: { sessionState: session },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Poole/AutoSage API Helpers
// Reference: POOLE_AUTOSAGE_IMPLEMENTATION_GUIDE.md § 2 (Endpoint Reference)
// ─────────────────────────────────────────────────────────────────────────────

async function getPooleConfig(garageId: string): Promise<PooleConfig> {
  const config = await prisma.agentConfiguration.findUnique({
    where: { garageId },
  });

  if (!config?.integrationProviderConfig) {
    throw new Error('Poole configuration not found');
  }

  const pooleConfig = (config.integrationProviderConfig as any)?.poole;
  if (!pooleConfig?.apiKey) {
    throw new Error('Poole API key not configured');
  }

  return {
    apiKey: pooleConfig.apiKey,
    branchCode: pooleConfig.branchCode || 'RST001', // Default to Lake Matilde for testing
    workspace: pooleConfig.workspace,
  };
}

const POOLE_BASE_URL = 'https://autosage-alpha-e6cucycjezh4guay.uksouth-01.azurewebsites.net';
const POOLE_TIMEOUT_MS = 15000; // 15s timeout

function getPooleHeaders(apiKey: string): Record<string, string> {
  return {
    'Key': apiKey,
    'Content-Type': 'application/json',
  };
}

/**
 * A1 · Find customer by phone
 * GET /inbound/customers?phone={phone}
 * Reference: § 2 (A1), § 6 (call sequence)
 */
async function poole_find_customer(config: PooleConfig, phone: string): Promise<any> {
  try {
    const response = await axios.get(
      `${POOLE_BASE_URL}/inbound/customers`,
      {
        params: { phone },
        headers: getPooleHeaders(config.apiKey),
        timeout: POOLE_TIMEOUT_MS,
      }
    );
    return response.data; // Array of customers
  } catch (error: any) {
    console.error('[POOLE_A1] Find customer error:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * A2 · Look up vehicle by registration
 * GET /inbound/vehicles/{registration}
 * Reference: § 2 (A2)
 */
async function poole_lookup_vehicle(config: PooleConfig, registration: string): Promise<any> {
  try {
    const response = await axios.get(
      `${POOLE_BASE_URL}/inbound/vehicles/${registration}`,
      {
        headers: getPooleHeaders(config.apiKey),
        timeout: POOLE_TIMEOUT_MS,
      }
    );
    return response.data;
  } catch (error: any) {
    if (error.response?.status === 404) {
      return { error: 'Vehicle not found in system' };
    }
    console.error('[POOLE_A2] Lookup vehicle error:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * B1 · Create draft booking
 * POST /inbound/bookings
 * Returns: { bookingRef: string }
 * Reference: § 2 (B1), § 4 (session state), § 6 (call sequence)
 * NOTE: callReference is IDEMPOTENCY KEY - repeating the same value returns existing booking
 */
async function poole_create_draft_booking(
  config: PooleConfig,
  callReference: string,
  notes?: string
): Promise<any> {
  try {
    const response = await axios.post(
      `${POOLE_BASE_URL}/inbound/bookings`,
      {
        callReference,
        branchCode: config.branchCode,
        notes: notes || '',
      },
      {
        headers: getPooleHeaders(config.apiKey),
        timeout: POOLE_TIMEOUT_MS,
      }
    );
    return response.data; // { bookingRef: string }
  } catch (error: any) {
    console.error('[POOLE_B1] Create booking error:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * B2 · List services with prices
 * GET /inbound/bookings/{bookingRef}/services
 * Returns: Array<{ serviceId, code, description, price, durationMinutes }>
 * Reference: § 2 (B2)
 */
async function poole_list_services(config: PooleConfig, bookingRef: string): Promise<any[]> {
  try {
    const response = await axios.get(
      `${POOLE_BASE_URL}/inbound/bookings/${bookingRef}/services`,
      {
        headers: getPooleHeaders(config.apiKey),
        timeout: POOLE_TIMEOUT_MS,
      }
    );
    return response.data || []; // Array of services
  } catch (error: any) {
    console.error('[POOLE_B2] List services error:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * B3 · Add services to booking
 * POST /inbound/bookings/{bookingRef}/services
 * Reference: § 2 (B3), § 6 (constraints: "replaces, not adds")
 * NOTE: serviceIds REPLACES entire selection - send full desired list each time
 */
async function poole_select_services(
  config: PooleConfig,
  bookingRef: string,
  serviceIds: number[]
): Promise<any> {
  try {
    const response = await axios.post(
      `${POOLE_BASE_URL}/inbound/bookings/${bookingRef}/services`,
      { serviceIds },
      {
        headers: getPooleHeaders(config.apiKey),
        timeout: POOLE_TIMEOUT_MS,
      }
    );
    return response.status === 202 ? { success: true } : response.data;
  } catch (error: any) {
    console.error('[POOLE_B3] Select services error:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * B4 · List available slots
 * GET /inbound/bookings/{bookingRef}/slots?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 * Returns: Array<{ date: "YYYY-MM-DD", times: ["HH:mm", ...] }>
 * Reference: § 2 (B4), § 6 (constraints: requires service first)
 * NOTE: Requires ≥1 service on booking (call B3 first)
 */
async function poole_list_slots(
  config: PooleConfig,
  bookingRef: string,
  startDate?: string,
  endDate?: string
): Promise<any[]> {
  try {
    const params: Record<string, string> = {};
    if (startDate) params.startDate = startDate;
    if (endDate) params.endDate = endDate;

    const response = await axios.get(
      `${POOLE_BASE_URL}/inbound/bookings/${bookingRef}/slots`,
      {
        params,
        headers: getPooleHeaders(config.apiKey),
        timeout: POOLE_TIMEOUT_MS,
      }
    );
    return response.data || []; // Array of { date, times[] }
  } catch (error: any) {
    if (error.response?.status === 409) {
      return { error: 'No services on booking yet - add a service first' };
    }
    console.error('[POOLE_B4] List slots error:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * B5 · Reserve a slot (soft hold)
 * PUT /inbound/bookings/{bookingRef}/slot
 * Reference: § 2 (B5), § 6 (soft hold revalidated at confirm)
 * NOTE: Soft hold - can be taken between B5 and B6 → prepare retry flow
 */
async function poole_reserve_slot(
  config: PooleConfig,
  bookingRef: string,
  date: string, // YYYY-MM-DD
  time: string  // HH:mm
): Promise<any> {
  try {
    const response = await axios.put(
      `${POOLE_BASE_URL}/inbound/bookings/${bookingRef}/slot`,
      { date, time },
      {
        headers: getPooleHeaders(config.apiKey),
        timeout: POOLE_TIMEOUT_MS,
      }
    );
    return response.status === 200 ? { success: true, date, time } : response.data;
  } catch (error: any) {
    console.error('[POOLE_B5] Reserve slot error:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * B6 · Confirm booking (MUTATING - DISABLE INTERRUPTIONS)
 * POST /inbound/bookings/{bookingRef}/confirm
 * Reference: § 2 (B6), § 6 (atomic & race-safe)
 * CRITICAL: Disable interruptions for this call - it's a write operation that can't be rolled back
 * NOTE: Safe to retry - already-confirmed booking returns unchanged
 */
async function poole_confirm_booking(
  config: PooleConfig,
  bookingRef: string,
  firstName: string,
  lastName: string,
  registration: string,
  mobile: string,
  options?: {
    title?: string;
    email?: string;
    make?: string;
    model?: string;
    mileage?: number;
  }
): Promise<any> {
  try {
    const payload: any = {
      customer: {
        firstName,
        lastName,
        mobile,
      },
      vehicle: {
        registration,
      },
    };

    if (options?.title) payload.customer.title = options.title;
    if (options?.email) payload.customer.email = options.email;
    if (options?.make) payload.vehicle.make = options.make;
    if (options?.model) payload.vehicle.model = options.model;
    if (options?.mileage) payload.mileage = options.mileage;

    const response = await axios.post(
      `${POOLE_BASE_URL}/inbound/bookings/${bookingRef}/confirm`,
      payload,
      {
        headers: getPooleHeaders(config.apiKey),
        timeout: POOLE_TIMEOUT_MS,
      }
    );
    return response.data; // Full booking with reference (job number)
  } catch (error: any) {
    if (error.response?.status === 409) {
      return { error: 'Slot unavailable or expired - please select a different time' };
    }
    console.error('[POOLE_B6] Confirm booking error:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * C1 · Reschedule to new slot (MUTATING)
 * PUT /inbound/bookings/{bookingRef}/reschedule
 * Reference: § 2 (C1)
 */
async function poole_reschedule_booking(
  config: PooleConfig,
  bookingRef: string,
  date: string,
  time: string
): Promise<any> {
  try {
    const response = await axios.put(
      `${POOLE_BASE_URL}/inbound/bookings/${bookingRef}/reschedule`,
      { date, time },
      {
        headers: getPooleHeaders(config.apiKey),
        timeout: POOLE_TIMEOUT_MS,
      }
    );
    return response.status === 200 ? { success: true, date, time } : response.data;
  } catch (error: any) {
    if (error.response?.status === 409) {
      return { error: 'New slot unavailable - original slot kept' };
    }
    console.error('[POOLE_C1] Reschedule error:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * C2 · Cancel with reason (MUTATING - DISABLE INTERRUPTIONS)
 * PUT /inbound/bookings/{bookingRef}/cancel
 * Reference: § 2 (C2)
 * NOTE: Safe to retry - already-cancelled booking returns 200
 */
async function poole_cancel_booking(
  config: PooleConfig,
  bookingRef: string,
  reason: string
): Promise<any> {
  try {
    const response = await axios.put(
      `${POOLE_BASE_URL}/inbound/bookings/${bookingRef}/cancel`,
      { reason },
      {
        headers: getPooleHeaders(config.apiKey),
        timeout: POOLE_TIMEOUT_MS,
      }
    );
    return response.status === 200 ? { success: true } : response.data;
  } catch (error: any) {
    console.error('[POOLE_C2] Cancel error:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * C3 · Retrieve booking (for status checks)
 * GET /inbound/bookings/{bookingRef}
 * Reference: § 2 (C3)
 */
async function poole_retrieve_booking(config: PooleConfig, bookingRef: string): Promise<any> {
  try {
    const response = await axios.get(
      `${POOLE_BASE_URL}/inbound/bookings/${bookingRef}`,
      {
        headers: getPooleHeaders(config.apiKey),
        timeout: POOLE_TIMEOUT_MS,
      }
    );
    return response.data;
  } catch (error: any) {
    console.error('[POOLE_C3] Retrieve booking error:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * D1 · Get branch details
 * GET /inbound/branches
 * Reference: § 2 (D1)
 */
async function poole_get_branch_details(config: PooleConfig): Promise<any> {
  try {
    const response = await axios.get(
      `${POOLE_BASE_URL}/inbound/branches`,
      {
        headers: getPooleHeaders(config.apiKey),
        timeout: POOLE_TIMEOUT_MS,
      }
    );
    return response.data; // Array with single branch (key-scoped)
  } catch (error: any) {
    console.error('[POOLE_D1] Get branches error:', error.response?.data || error.message);
    throw error;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Chat Handler
// ─────────────────────────────────────────────────────────────────────────────

export async function getPooleResponse(
  garageId: string,
  message: string,
  conversationId: string
): Promise<ChatAgentResponse> {
  try {
    const config = await getPooleConfig(garageId);
    const session = await getOrCreateSession(conversationId);

    // TODO: Wire up LLM + tools for Poole flow
    // This is the skeleton; tool handlers will be added next

    const placeholder = `[POOLE_AGENT] Received: "${message}" - Integration in progress`;
    return { content: placeholder };

  } catch (error: any) {
    console.error('[POOLE_RESPONSE] Error:', error.message);
    return {
      content: `Sorry, something went wrong on our end. Please call the garage directly. Error: ${error.message}`,
      needsHumanAssistance: true,
    };
  }
}

export default {
  getPooleResponse,
};
