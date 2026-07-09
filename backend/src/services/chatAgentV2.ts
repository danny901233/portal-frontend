import { prisma } from '../db.js';
import { notifyMessaging } from './messagingNotifications.js';
import OpenAI from 'openai';
import axios from 'axios';
import { logChatToolCall } from './chatToolLog.js';
import { imageMessageContent } from './chatMedia.js';
import { getVehicleAdvisories } from './garageHiveBc.js';

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

// Multi-branch configuration — loaded from customRules.branches
let GARAGE_BRANCHES: { name: string; locationId: string }[] = [];

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
  NEED_BRANCH = 'need_branch',
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
  serviceSelectedIds: string[];   // all selected service IDs (multi-service bookings)
  serviceSelectedNames: string[]; // matching display names
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
  outboundUpsellOffered?: boolean;
  // Advisory upsells (VHC) — outstanding health-check advisories on this vehicle,
  // offered as an add-on during a reminder booking. Server-side toggle gates the data.
  advisoryText?: string;
  advisoryOffered?: boolean;
  upsellServiceId?: string;     // service ID saved during upsell, prepended when adding a 2nd service
  upsellServiceName?: string;   // display name of upsell service (for UPSELL_FOLLOW_UP prompt)
  upsellServicePrice?: string;  // price of upsell service — carried through so combined total can be shown
  additionalServiceName?: string;  // original service retained after upsell add-on consumed (e.g. MOT when Full Service added)
  additionalServicePrice?: string; // price of additionalServiceName

  // Widget pre-fill: service hint from initial message (e.g. "MOT")
  serviceHint?: string;

  // Branch selection (for garages with multiple locations)
  selectedBranch?: string;

  // Preferred date stated by customer (e.g. "Tuesday 19th", "next week")
  // Preserved across step changes so LLM can use it after "No" rejections
  preferredDate?: string;

  // Last date we showed a slot list for — anchors bare time picks ("1pm") to the right date
  slotsShownDate?: string;

  // Preferred time stated by customer (e.g. "5pm", "morning", "afternoon")
  // Carried forward so day-only changes ("Monday instead") keep the time constraint
  preferredTime?: string;

  // Warm resume: set when session resumes after 8-72h gap, cleared after first LLM response
  warmResumeContext?: string;

  // Message-taking: set when customer wants to leave a message, next turn captures the content
  collectingMessage?: boolean;
  preMessageStep?: string; // step before message-taking started (for booking resume)

  // Transient: raw customer message for the current turn (not persisted to DB)
  lastCustomerMessage?: string;
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

// Normalize common day-name typos (e.g. "Satruday" → "saturday", "Wensday" → "wednesday")
// Uses character-sort comparison, char-diff, and simple levenshtein for length mismatches
function normalizeDayTypos(text: string): string {
  const dayNames = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  return text.replace(/\b[a-zA-Z]{5,11}\b/g, (word) => {
    const w = word.toLowerCase();
    if (dayNames.includes(w)) return word; // already correct
    for (const day of dayNames) {
      if (Math.abs(w.length - day.length) > 2) continue;
      // Same letters reordered (transpositions like "Satruday" → "saturday")
      if (w.length === day.length && w.split('').sort().join('') === day.split('').sort().join('')) return day;
      // Character diff ≤ 2 for same-length words
      if (w.length === day.length) {
        let diffs = 0;
        for (let i = 0; i < w.length; i++) if (w[i] !== day[i]) diffs++;
        if (diffs <= 2) return day;
      }
      // Length differs (missing/extra letters like "Wensday"→"wednesday", "Thurday"→"thursday")
      // Check if shorter string is a subsequence of longer with ≤ 2 gaps
      if (w.length !== day.length) {
        const short = w.length < day.length ? w : day;
        const long = w.length < day.length ? day : w;
        let si = 0, gaps = 0;
        for (let li = 0; li < long.length && si < short.length; li++) {
          if (long[li] === short[si]) si++;
          else gaps++;
        }
        gaps += (short.length - si); // unmatched chars at end
        if (si === short.length && gaps <= 2) return day;
      }
    }
    return word;
  });
}

// Session storage - persist to database
async function getOrCreateSession(conversationId: string): Promise<ChatSession> {
  const cached = inMemorySessionCache.get(conversationId);
  if (cached) {
    sessionLastAccessed.set(conversationId, Date.now());
    return { ...cached };
  }

  console.log(`[GET_SESSION] Loading session for conversation ${conversationId}`);
  
  // Try to load from database using raw SQL (sessionState column may not be in Prisma types)
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ sessionState: any; lastMessageAt: Date | null }>>(
      `SELECT "sessionState", "lastMessageAt" FROM "ChatConversation" WHERE id = $1`,
      conversationId
    );
    
    if (rows.length > 0 && rows[0].sessionState) {
      // If the session hasn't been touched for 8 hours, treat as a fresh conversation.
      // IMPORTANT: use sessionUpdatedAt (written by saveSession) NOT lastMessageAt —
      // the webhook updates lastMessageAt BEFORE this function runs, so it's always "now"
      // and a time-based expiry on lastMessageAt never fires.
      const sessionData0 = rows[0].sessionState as any;
      const lastUpdated = sessionData0?.sessionUpdatedAt
        ? new Date(sessionData0.sessionUpdatedAt)
        : (rows[0].lastMessageAt ? new Date(rows[0].lastMessageAt) : null);
      const ageMs = lastUpdated ? Date.now() - lastUpdated.getTime() : Infinity;
      const WARM_EXPIRY_MS = 8 * 60 * 60 * 1000;  // 8 hours
      const COLD_EXPIRY_MS = 72 * 60 * 60 * 1000; // 72 hours

      if (ageMs > COLD_EXPIRY_MS) {
        // ── Tier 3: Cold resume (>72h) — full reset, preserve only name + phone + email ──
        console.log(`[GET_SESSION] Cold expired (${Math.round(ageMs / 60000)}min ago) — full reset`);
        const oldData = rows[0].sessionState as any;
        const freshSession: ChatSession = {
          step: Step.GREETING,
          intent: '',
          customerNameFirst: oldData.customerNameFirst || '',
          customerNameLast: oldData.customerNameLast || '',
          vrn: '', vrnConfirmed: false, sessionId: '',
          vehicleMake: '', vehicleModel: '',
          servicesAvailable: [], serviceSelectedId: '', serviceSelectedName: '', serviceSelectedIds: [], serviceSelectedNames: [], servicePrice: '',
          timeslotsAvailable: [], pendingSlotDate: '', pendingSlotTime: '',
          bookingDate: '', bookingTime: '',
          contactPhone: oldData.contactPhone || '',
          contactEmail: oldData.contactEmail || '',
          contactPostcode: '', contactStreet: '', contactCity: '', contactHouseNumber: '',
          postcodeConfirmed: false, notes: '',
          message: '', preferredCallbackTime: '',
          diagnosticNotes: '', diagnosticComplete: false, diagnosticQuestions: [],
          useDropOffBooking: false,
          selectedBranch: '',
        };
        inMemorySessionCache.set(conversationId, freshSession);
        return freshSession;

      } else if (ageMs > WARM_EXPIRY_MS) {
        // ── Tier 2: Warm resume (8-72h) — preserve vehicle/contact/outbound, clear stale booking state ──
        const oldData = rows[0].sessionState as any;
        const hadVrnConfirmed = !!(oldData.vrnConfirmed && oldData.vrn);

        // Build context string so LLM can greet returning customer naturally
        const ctxParts: string[] = [];
        if (oldData.vehicleMake && oldData.vrn)
          ctxParts.push(`${oldData.vehicleMake} ${oldData.vehicleModel || ''} (${oldData.vrn})`.trim());
        if (oldData.serviceSelectedName)
          ctxParts.push(`was booking: ${oldData.serviceSelectedName}`);
        if (oldData.outboundServiceType)
          ctxParts.push(`outbound ${oldData.outboundServiceType} reminder`);
        ctxParts.push(`got to step: ${oldData.step || 'greeting'}`);

        const resumeStep = hadVrnConfirmed ? Step.NEED_SERVICE
          : (oldData.vrn ? Step.NEED_VRN : Step.GREETING);

        console.log(`[GET_SESSION] Warm resume (${Math.round(ageMs / 60000)}min ago) — step=${resumeStep}, vrn=${hadVrnConfirmed ? oldData.vrn : 'cleared'}`);

        const warmSession: ChatSession = {
          step: resumeStep,
          intent: '',
          // ── Preserved: customer identity ──
          customerNameFirst: oldData.customerNameFirst || '',
          customerNameLast: oldData.customerNameLast || '',
          contactPhone: oldData.contactPhone || '',
          contactEmail: oldData.contactEmail || '',
          contactPostcode: oldData.contactPostcode || '',
          contactStreet: oldData.contactStreet || '',
          contactCity: oldData.contactCity || '',
          contactHouseNumber: oldData.contactHouseNumber || '',
          postcodeConfirmed: oldData.postcodeConfirmed || false,
          // ── Preserved: vehicle (if was confirmed) ──
          vrn: hadVrnConfirmed ? (oldData.vrn || '') : '',
          vrnConfirmed: hadVrnConfirmed,
          vehicleMake: hadVrnConfirmed ? (oldData.vehicleMake || '') : '',
          vehicleModel: hadVrnConfirmed ? (oldData.vehicleModel || '') : '',
          // ── Preserved: outbound context ──
          outboundRegistration: oldData.outboundRegistration || undefined,
          outboundServiceType: oldData.outboundServiceType || undefined,
          outboundDueDate: oldData.outboundDueDate || undefined,
          outboundUpsellOffered: false, // reset — allow upsell again
          // ── Preserved: branch ──
          selectedBranch: oldData.selectedBranch || '',
          // ── Cleared: GH session (expired after hours) ──
          sessionId: '',
          // ── Cleared: stale booking progress ──
          servicesAvailable: [], serviceSelectedId: '', serviceSelectedName: '',
          serviceSelectedIds: [], serviceSelectedNames: [], servicePrice: '',
          timeslotsAvailable: [], pendingSlotDate: '', pendingSlotTime: '',
          bookingDate: '', bookingTime: '',
          notes: '', message: '', preferredCallbackTime: '',
          diagnosticNotes: '', diagnosticComplete: false, diagnosticQuestions: [],
          useDropOffBooking: false,
          // ── Warm resume context for LLM prompt ──
          warmResumeContext: `Customer was previously chatting. ${ctxParts.join(', ')}.`,
        };
        inMemorySessionCache.set(conversationId, warmSession);
        return warmSession;
      }

      const sessionData = rows[0].sessionState as any;
      console.log(`[GET_SESSION] Found existing session, step: ${sessionData.step}, typeof sessionState: ${typeof rows[0].sessionState}, keys: ${Object.keys(rows[0].sessionState || {}).slice(0, 10).join(',')}`);
      if (!sessionData.step) console.log(`[GET_SESSION] RAW sessionState: ${JSON.stringify(rows[0].sessionState).substring(0, 300)}`);
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
        serviceSelectedIds: sessionData.serviceSelectedIds || [],
        serviceSelectedNames: sessionData.serviceSelectedNames || [],
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
        outboundUpsellOffered: sessionData.outboundUpsellOffered || false,
        upsellServiceId: sessionData.upsellServiceId || undefined,
        upsellServiceName: sessionData.upsellServiceName || undefined,
        preferredDate: sessionData.preferredDate || '',
        slotsShownDate: sessionData.slotsShownDate || '',
        preferredTime: sessionData.preferredTime || undefined,
        warmResumeContext: sessionData.warmResumeContext || undefined,
        collectingMessage: sessionData.collectingMessage || false,
        preMessageStep: sessionData.preMessageStep || undefined,
      };
      // Guard: if session is mid-booking but has no GarageHive sessionId, the previous
      // vehicle lookup failed or was never saved. Reset back to need_vrn so the bot
      // re-runs lookup_vehicle. Keep the VRN so the user doesn't have to re-type it.
      const BOOKING_STEPS_NEEDING_SESSION = [
        Step.NEED_SERVICE, Step.NEED_BOOKING_CONFIRM, Step.NEED_TIMESLOT,
        Step.NEED_SLOT_CONFIRM, Step.NEED_CONTACT, Step.CONFIRMING_POSTCODE, Step.CONFIRMED
      ];
      const isOutboundSession = !!(loadedSession.outboundRegistration && loadedSession.vrn);
      if (BOOKING_STEPS_NEEDING_SESSION.includes(loadedSession.step as Step) && !loadedSession.sessionId && !isOutboundSession) {
        console.log(`[GET_SESSION] Step is ${loadedSession.step} but sessionId is empty — resetting to need_vrn (vrn: ${loadedSession.vrn})`);
        loadedSession.step = Step.NEED_VRN;
        loadedSession.vrnConfirmed = false;
        loadedSession.servicesAvailable = [];
        loadedSession.serviceSelectedId = '';
        loadedSession.serviceSelectedName = '';
        loadedSession.serviceSelectedIds = [];
        loadedSession.serviceSelectedNames = [];
        loadedSession.servicePrice = '';
        loadedSession.timeslotsAvailable = [];
        loadedSession.pendingSlotDate = '';
        loadedSession.pendingSlotTime = '';
      }

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
    serviceSelectedIds: [],
    serviceSelectedNames: [],
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
    selectedBranch: '',
  };

  inMemorySessionCache.set(conversationId, newSession);
  return newSession;
}

async function saveSession(conversationId: string, session: ChatSession): Promise<void> {
  inMemorySessionCache.set(conversationId, { ...session });
  sessionLastAccessed.set(conversationId, Date.now());
  console.log(`[SAVE_SESSION] Saving session for ${conversationId}, step: ${session.step}, phone: ${session.contactPhone}`);
  
  try {
    // Strip large timeslot array before saving to DB (keep only first 5 for recovery)
    const sessionToSave = {
      ...session,
      timeslotsAvailable: (session.timeslotsAvailable || []).slice(0, 5),
      sessionUpdatedAt: new Date().toISOString(), // used for reliable expiry check
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

export function invalidateSessionCache(conversationId: string): void {
  inMemorySessionCache.delete(conversationId);
  console.log(`[SESSION_CACHE] Invalidated cache for ${conversationId}`);
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

    // Load GarageHive credentials
    if (config.integrationProviderConfig && typeof config.integrationProviderConfig === 'object') {
      const rawConfig = config.integrationProviderConfig as any;
      // Support both nested { garagehive: { ... } } and flat { customerId: ... } formats
      const ghConfig = rawConfig.garagehive || rawConfig;
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

    // Store raw customer message so tool handlers (e.g. handleSelectService) can check it
    session.lastCustomerMessage = message;

    // ── Stale slot guard: clear past-date timeslots even within active sessions ──
    if (session.pendingSlotDate) {
      const pendingDate = new Date(session.pendingSlotDate + 'T23:59:59');
      if (pendingDate < new Date()) {
        console.log(`[STALE_GUARD] pendingSlotDate ${session.pendingSlotDate} is in the past — clearing`);
        session.pendingSlotDate = '';
        session.pendingSlotTime = '';
        if (session.step === Step.NEED_SLOT_CONFIRM) {
          session.step = Step.NEED_TIMESLOT;
        }
      }
    }
    if (session.timeslotsAvailable?.length > 0) {
      const today = new Date().toISOString().slice(0, 10);
      const freshSlots = session.timeslotsAvailable.filter((t: any) => t.date >= today);
      if (freshSlots.length < session.timeslotsAvailable.length) {
        console.log(`[STALE_GUARD] Pruned ${session.timeslotsAvailable.length - freshSlots.length} past-date timeslots`);
        session.timeslotsAvailable = freshSlots;
      }
    }

    // Check if this garage has multiple branches and set initial step
    GARAGE_BRANCHES = (config as any).customRules?.branches ?? [];
    const hasMultipleBranches = GARAGE_BRANCHES.length > 1;
    console.log(`[BRANCH_CHECK] branchName: "${config.branchName}", branches: ${GARAGE_BRANCHES.length}, step: ${session.step}, selectedBranch: ${session.selectedBranch}`);
    if (hasMultipleBranches && session.step === Step.GREETING && !session.selectedBranch) {
      session.step = Step.NEED_BRANCH;
      await saveSession(conversationId, session);
      console.log(`[BRANCH_SELECTION] Multi-branch garage detected, step set to NEED_BRANCH`);
    }

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

    // Outbound fastpath: auto-lookup vehicle on first customer reply (don't wait for LLM)
    if (session.outboundRegistration && !session.vrn && !session.vrnConfirmed &&
        (session.step === Step.NEED_VRN || session.step === Step.GREETING)) {
      console.log(`[OUTBOUND_FASTPATH] Auto-looking up ${session.outboundRegistration}`);
      const lookupResult = await handleLookupVehicle({ registration: session.outboundRegistration }, session, conversationId);
      if (lookupResult.includes('Found:') || lookupResult.includes('confirm_vehicle')) {
        // Vehicle found — now auto-confirm it
        const confirmResult = await handleConfirmVehicle({ confirmed: true }, session, conversationId);
        const vehicleMsg = instructionToCustomerReply(confirmResult);
        console.log(`[OUTBOUND_FASTPATH] Vehicle confirmed, returning combined response`);
        await saveSession(conversationId, session);
        return { content: vehicleMsg, needsHumanAssistance: false };
      }
    }

    // Outbound service fastpath: auto-select service for outbound reminders (MOT or Full Service)
    // The webhook seeds step=need_service with vrn already set, so the vehicle fast-path above
    // doesn't fire. We need to auto-select the service here instead of relying on the LLM.
    if (session.outboundServiceType && session.vrn && session.vrnConfirmed &&
        session.step === Step.NEED_SERVICE && !session.serviceSelectedName && !session.outboundUpsellOffered) {
      const serviceName = session.outboundServiceType === 'service' ? 'Full Service' : 'MOT';
      console.log(`[OUTBOUND_SERVICE_FASTPATH] Auto-selecting ${serviceName} for outbound ${session.outboundServiceType} reminder`);
      if (!session.sessionId) {
        await handleLookupVehicle({ registration: session.vrn }, session, conversationId);
        await handleConfirmVehicle({ confirmed: true }, session, conversationId);
      }
      const serviceResult = await handleSelectService({ service_name: serviceName }, session, conversationId);
      let serviceMsg = instructionToCustomerReply(serviceResult);

      // Advisory upsell: if the garage has it enabled and this vehicle has outstanding
      // health-check advisories, offer them as an add-on to the reminder booking.
      // getVehicleAdvisories returns nothing unless the toggle is on, so this is inert
      // until a garage opts in.
      try {
        if (!session.advisoryOffered) {
          const { advisories } = await getVehicleAdvisories(garageId, session.vrn);
          if (advisories.length > 0) {
            const items = advisories.slice(0, 4).map((a) =>
              a.price ? `${a.description} (about £${Math.round(a.price)})` : a.description,
            );
            session.advisoryText = items.join('; ');
            session.advisoryOffered = true;
            serviceMsg +=
              `\n\nBy the way — when we last had your vehicle in we advised ${items.join(', ')}. ` +
              `Would you like that sorted at the same time? Just say yes and I'll add it to the booking.`;
          }
        }
      } catch (e) {
        console.error('[ADVISORY] chat advisory lookup failed:', e);
      }

      await saveSession(conversationId, session);
      console.log(`[OUTBOUND_SERVICE_FASTPATH] ${serviceName} selected, step now: ${session.step}`);
      return { content: serviceMsg, needsHumanAssistance: false };
    }

    // Build conversation context
    // Skip old history for fresh outbound sessions — the old messages confuse the LLM
    // into following previous broken patterns instead of the fresh outbound instructions.
    const isOutboundFresh = !!(session.outboundRegistration &&
      (session.step === Step.NEED_VRN ||
       session.step === Step.NEED_SERVICE ||
       (session.step as string) === 'confirming_vehicle'));
    const previousMessages = await prisma.chatMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
      take: isOutboundFresh ? 0 : 10,
    });

    hydrateSessionFromMessageHistory(session, previousMessages as Array<{ role: string; content: string }>);

    // Re-apply seed after hydration to ensure it wins over any contradictory history
    if (seedContact?.phone && !session.contactPhone) {
      session.contactPhone = seedContact.phone.replace(/\s+/g, '');
      seedApplied = true;
    }

    // Also scan the CURRENT message for contact details (e.g. user puts phone in their first message)
    if (!session.contactPhone) {
      const normalisedMsg = normaliseVoiceToText(message);
      const phoneMsgMatches = [...normalisedMsg.matchAll(/\+[\d\s\-]{7,18}|\b0\d[\d\s\-]{8,13}|\b44\d[\d\s\-]{7,12}/g)];
      if (phoneMsgMatches.length > 0) {
        const hasMsgCorrection = /\b(no wait|actually|sorry|wrong|not that|old number|that.?s wrong|meant to say)\b/i.test(message);
        const chosenMsgPhone = (hasMsgCorrection && phoneMsgMatches.length > 1)
          ? phoneMsgMatches[phoneMsgMatches.length - 1][0]
          : phoneMsgMatches[0][0];
        session.contactPhone = chosenMsgPhone.replace(/\s+/g, '');
        console.log(`[SEED_CONTACT] Phone found in message: ${session.contactPhone}${hasMsgCorrection ? ' (corrected)' : ''}`);
        seedApplied = true;
      }
    }

    // Persist seeded data immediately so a backend restart won't lose it
    if (seedApplied) {
      await saveSession(conversationId, session);
    }

    // ── MESSAGE_CONTENT_FASTPATH: collectingMessage flag is set — this message IS the content ──
    // Fires before anything else so the customer's message goes straight to take_message
    if (session.collectingMessage) {
      console.log(`[MESSAGE_CONTENT_FASTPATH] Capturing message content (preMessageStep: ${session.preMessageStep})`);
      session.collectingMessage = false;
      const savedStep = session.preMessageStep || '';
      session.preMessageStep = undefined;

      // Call handleTakeMessage with the customer's raw message
      await handleTakeMessage(
        { message: message, phone: session.contactPhone || '', callback_time: '' },
        session,
        conversationId
      );

      // If a booking was in progress, offer to resume
      const bookingSteps = [Step.NEED_SERVICE, Step.NEED_TIMESLOT, Step.NEED_SLOT_CONFIRM, Step.NEED_CONTACT, Step.CONFIRMING_VEHICLE];
      const wasBooking = bookingSteps.includes(savedStep as Step) || session.serviceSelectedName;
      const serviceName = session.serviceSelectedName || session.outboundServiceType?.toUpperCase() || 'your booking';

      if (wasBooking) {
        // Restore step so booking can continue
        session.step = savedStep as Step || Step.NEED_SERVICE;
        await saveSession(conversationId, session);
        console.log(`[MESSAGE_CONTENT_FASTPATH] Message saved, resuming booking at step: ${session.step}`);
        return {
          content: `Got it, ${session.customerNameFirst || 'there'} — I've passed that on and the team will be in touch. Now, shall we carry on with ${serviceName}?`,
          needsHumanAssistance: false,
        };
      }

      return {
        content: `Got it, ${session.customerNameFirst || 'there'} — I've passed that on and the team will give you a call back. Is there anything else I can help with?`,
        needsHumanAssistance: false,
      };
    }

    // ── MESSAGE_COLLECTING_FASTPATH: customer wants to leave a message mid-conversation ──
    // Detects "leave a message" / "take a message" / "pass on a message" intent
    // Sets collectingMessage flag so the NEXT turn captures the content directly
    {
      const lower = message.toLowerCase().replace(/[^a-z\s]/g, '').trim();
      const wantsMessage = /\b(leave|take|pass on|send)\s+(a\s+)?(message|note|msg)\b/.test(lower)
        || /\b(just\s+)?(a\s+)?message\s*(please|thanks|for them|for the team)?\s*$/i.test(lower);
      // Don't trigger if we're already in MESSAGE_ONLY or CONFIRMED state
      if (wantsMessage && session.step !== Step.MESSAGE_ONLY && session.step !== Step.CONFIRMED && session.step !== Step.DONE) {
        console.log(`[MESSAGE_COLLECTING_FASTPATH] Customer wants to leave a message at step: ${session.step}`);
        session.collectingMessage = true;
        session.preMessageStep = session.step;
        await saveSession(conversationId, session);
        return {
          content: `Of course, ${session.customerNameFirst || 'no problem'}! What would you like me to pass on to the team?`,
          needsHumanAssistance: false,
        };
      }
    }

    // Fast-path: restart/cancel detection — customer wants to start over or give up
    // Only trigger before booking is confirmed (no point resetting after CONFIRMED/DONE)
    if (session.step !== Step.CONFIRMED && session.step !== Step.DONE && session.step !== Step.GREETING) {
      const lower = message.toLowerCase().replace(/[^a-z\s]/g, '').trim();
      // "forget it" / "never mind" only restart if standalone — not when followed by a date/alternative
      // e.g. "forget it then, next thursday" = reschedule, not cancel
      const hasFollowUpIntent = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|tomorrow|next|instead|earliest|soonest|actually)\b/.test(lower);
      const isNevermind = /\b(forget it|never ?mind)\b/.test(lower) && !hasFollowUpIntent;
      const isHardRestart = /\b(start (over|again)|restart|reset|begin again|wrong (garage|number|chat)|different (garage|car|vehicle)|cancel (booking|this|everything)|start from (the )?beginning)\b/.test(lower);
      const isRestart = isHardRestart || (isNevermind && ![Step.NEED_TIMESLOT, Step.NEED_SLOT_CONFIRM].includes(session.step as any));
      // Also reset if customer left a message but now wants to book
      const wantsBookingAfterMessage = session.step === Step.MESSAGE_ONLY &&
        /\b(book|booking|service|mot|appointment|slot|come in|bring (it|the car)|actually|instead)\b/.test(lower);
      if (isRestart || wantsBookingAfterMessage) {
        console.log(`[RESTART] Customer requested restart at step: ${session.step} (wantsBooking: ${wantsBookingAfterMessage})`);
        // Wipe all booking state but keep name + contact if already collected
        const savedName = { first: session.customerNameFirst, last: session.customerNameLast };
        const savedContact = { phone: session.contactPhone, email: session.contactEmail };
        Object.assign(session, {
          step: Step.GREETING,
          intent: '',
          vrn: '', vrnConfirmed: false, sessionId: '',
          vehicleMake: '', vehicleModel: '',
          servicesAvailable: [], serviceSelectedId: '', serviceSelectedName: '', serviceSelectedIds: [], serviceSelectedNames: [], servicePrice: '',
          timeslotsAvailable: [], pendingSlotDate: '', pendingSlotTime: '',
          bookingDate: '', bookingTime: '',
          contactPostcode: '', contactStreet: '', contactCity: '', contactHouseNumber: '',
          postcodeConfirmed: false, notes: '',
          message: '', preferredCallbackTime: '',
          diagnosticNotes: '', diagnosticComplete: false, diagnosticQuestions: [],
          useDropOffBooking: false,
        });
        session.customerNameFirst = savedName.first;
        session.customerNameLast = savedName.last;
        session.contactPhone = savedContact.phone;
        session.contactEmail = savedContact.email;
        await saveSession(conversationId, session);
        const nameGreet = savedName.first ? `, ${savedName.first}` : '';
        return {
          content: `No problem${nameGreet}! Let's start fresh. What can I help you with?`,
          needsHumanAssistance: false,
        };
      }

      // Soft "nevermind" at timeslot steps — clear slot state, offer alternatives
      if (isNevermind && [Step.NEED_TIMESLOT, Step.NEED_SLOT_CONFIRM].includes(session.step as any)) {
        console.log(`[SOFT_NEVERMIND] Clearing timeslot state at step: ${session.step}`);
        const isAiConcern = /\b(ai|bot|automated|robot|not (a )?human|talking to (a )?(machine|computer))\b/i.test(message);

        session.pendingSlotDate = '';
        session.pendingSlotTime = '';
        session.preferredDate = '';
        session.slotsShownDate = '';
        session.step = Step.NEED_TIMESLOT;
        await saveSession(conversationId, session);

        const spread = formatSlotSpread(session.timeslotsAvailable || []);
        if (isAiConcern) {
          return {
            content: `I'm Leah, the garage's AI assistant — happy to help! If you'd prefer to speak to someone, just let me know. Otherwise I've got ${spread} available — any of those work?`,
            needsHumanAssistance: false,
          };
        }
        return {
          content: `No worries! I've got ${spread} available — any of those work?`,
          needsHumanAssistance: false,
        };
      }
    }

    // Save preferred date whenever customer mentions one — not just at NEED_TIMESLOT
    // Captures dates from the opening message ("can I book this Friday") for later use
    // Uses LAST match so "If sunday is closed, do you do Saturday?" captures "Saturday" not "sunday"
    if (!session.bookingDate) {
      const normalizedMsg = normalizeDayTypos(message); // fix typos like "Satruday" → "saturday"
      const dateRegex = /\b(tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next\s+\w+|\d{1,2}(?:st|nd|rd|th)?(?:\s+of)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*|\d{4}-\d{2}-\d{2}|\d{1,2}(?:st|nd|rd|th)(?:\s+(?:may|june|july))?|\d{1,2}\s+(?:of\s+)?(?:may|june|july))\b/gi;
      const allDateMatches = [...normalizedMsg.matchAll(dateRegex)];
      const lastMatch = allDateMatches.length > 0 ? allDateMatches[allDateMatches.length - 1][0] : null;
      if (lastMatch && lastMatch.toLowerCase() !== (session.preferredDate || '').toLowerCase()) {
        session.preferredDate = lastMatch;
        await saveSession(conversationId, session);
        console.log(`[PREFERRED_DATE] Saved: "${session.preferredDate}" (step: ${session.step})`);
      }
    }

    // Save preferred time whenever customer mentions one — carried forward across day changes
    // "past 5pm" / "after 3" / "5pm" / "morning" / "afternoon" / "evening" → saved
    // "any time" / "earliest" / "don't mind" → cleared
    if (!session.bookingTime) {
      const timeLower = message.toLowerCase();
      const clearTime = /\b(any\s*time|earliest|soonest|don'?t\s*mind|whenever|no\s*preference|flexible)\b/i.test(timeLower);
      if (clearTime && session.preferredTime) {
        session.preferredTime = undefined;
        await saveSession(conversationId, session);
        console.log(`[PREFERRED_TIME] Cleared (customer said flexible)`);
      } else {
        // Match specific times: "5pm", "past 3pm", "after 5", "around 2pm"
        const timeMatch = timeLower.match(/\b(?:past|after|from|around|at|by)?\s*(\d{1,2})\s*(?::(\d{2}))?\s*(am|pm)?\b/i);
        // Match period words: "morning", "afternoon", "evening"
        const periodMatch = timeLower.match(/\b(morning|afternoon|evening)\b/i);
        let newTime: string | undefined;
        if (timeMatch) {
          let h = parseInt(timeMatch[1], 10);
          const m = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
          const mer = (timeMatch[3] || '').toLowerCase();
          if (mer === 'pm' && h < 12) h += 12;
          if (mer === 'am' && h === 12) h = 0;
          if (!mer && h >= 1 && h <= 6) h += 12; // 1-6 without am/pm = PM in booking context
          if (h >= 7 && h <= 23) { // reasonable booking hour
            newTime = `${h}:${String(m).padStart(2, '0')}`;
          }
        } else if (periodMatch) {
          newTime = periodMatch[1].toLowerCase(); // "morning", "afternoon", "evening"
        }
        if (newTime && newTime !== session.preferredTime) {
          session.preferredTime = newTime;
          await saveSession(conversationId, session);
          console.log(`[PREFERRED_TIME] Saved: "${session.preferredTime}" (step: ${session.step})`);
        }
      }
    }

    // VRN_FASTPATH: at need_vrn, detect UK registration pattern and call lookup + confirm directly
    // Skips 2 LLM round-trips — in chat the customer types clearly, no need for LLM to extract VRN
    if (session.step === Step.NEED_VRN) {
      const stripped = message.replace(/\s+/g, '').toUpperCase();
      // UK VRN patterns: AB12CDE (new), AB12 CDE, A123BCD (old), A12BCD, etc.
      const isVrn = /^[A-Z]{2}\d{2}[A-Z]{2,3}$/.test(stripped) ||   // new style: KE18PBX
                    /^[A-Z]\d{1,3}[A-Z]{3}$/.test(stripped) ||        // old style: A123BCD
                    /^[A-Z]{3}\d{1,3}[A-Z]$/.test(stripped) ||        // suffix: BCD123A
                    /^[A-Z]{1,3}\d{1,4}$/.test(stripped) ||            // dateless: AB1234
                    /^\d{1,4}[A-Z]{1,3}$/.test(stripped);              // dateless reverse: 1234AB
      if (isVrn) {
        console.log(`[VRN_FASTPATH] Detected VRN "${stripped}" at need_vrn — calling lookup directly`);
        const lookupResult = await handleLookupVehicle({ registration: stripped }, session, conversationId);
        if (lookupResult.includes('Vehicle found') || lookupResult.includes('confirm_vehicle')) {
          // Auto-confirm in chat — customer can see the details and correct if wrong
          const confirmResult = await handleConfirmVehicle({ confirmed: true }, session, conversationId);
          const sayMatch = confirmResult.match(/Say:\s*"([\s\S]*?)"/i);
          if (sayMatch) {
            await saveSession(conversationId, session);
            console.log(`[VRN_FASTPATH] Vehicle confirmed, step: ${session.step}`);
            return { content: sayMatch[1].trim(), needsHumanAssistance: false };
          }
        }
        // Lookup failed or partial — extract the Say message and let the user retry
        const failSay = lookupResult.match(/Say:\s*"([\s\S]*?)"/i);
        if (failSay) return { content: failSay[1].trim(), needsHumanAssistance: false };
        // No Say pattern — return a sensible fallback instead of silently dropping the result
        console.log(`[VRN_FASTPATH] No Say pattern in lookup result — returning fallback`);
        return { content: "I wasn't able to find that registration — could you double-check it and try again?", needsHumanAssistance: false };
      }
    }

    // VEHICLE_CONFIRM_FASTPATH: at confirming_vehicle, detect obvious yes and confirm directly
    if (session.step === Step.CONFIRMING_VEHICLE) {
      const lowerMsg = message.trim().toLowerCase().replace(/[^a-z0-9\s]/g, '');
      const isYes = /^(ye+s*|ye+p+|yea+h*|sure|ok(ay)?|correct|thats? (right|correct|it|mine|the one)|looks? (right|good|correct)|confirmed?)(\s+(please|thanks|cheers|ta|mate|thx))*$/i.test(lowerMsg);
      const isNo = /^(no+|nah+|nope|wrong|not (mine|right|correct|that|my)|different (car|vehicle))(\s+(sorry|mate))*$/i.test(lowerMsg);
      if (isYes) {
        console.log(`[VEHICLE_CONFIRM_FASTPATH] Obvious yes "${message}" — confirming vehicle directly`);
        const confirmResult = await handleConfirmVehicle({ confirmed: true }, session, conversationId);
        const sayMatch = confirmResult.match(/Say:\s*"([\s\S]*?)"/i);
        if (sayMatch) {
          await saveSession(conversationId, session);
          return { content: sayMatch[1].trim(), needsHumanAssistance: false };
        }
      }
      if (isNo) {
        console.log(`[VEHICLE_CONFIRM_FASTPATH] Obvious no "${message}" — resetting to need_vrn`);
        const confirmResult = await handleConfirmVehicle({ confirmed: false }, session, conversationId);
        const sayMatch = confirmResult.match(/Say:\s*"([\s\S]*?)"/i);
        if (sayMatch) {
          await saveSession(conversationId, session);
          return { content: sayMatch[1].trim(), needsHumanAssistance: false };
        }
      }
    }

    // UPSELL_SERVICE_FASTPATH: during upsell, if customer confirms adding a service that's in our
    // available services list, call select_service directly instead of relying on the LLM.
    // Catches: "Yes, brakes too" / "yeah book the brakes" / "yes can I book that on same slot"
    const isUpsellPending = !!(session.upsellServiceId && session.step === Step.NEED_SERVICE);
    if (isUpsellPending && session.servicesAvailable?.length > 0) {
      const lower = message.toLowerCase();
      // Check decline FIRST — "No thanks, just the MOT" should decline, not re-select MOT
      const isDecline = /\b(no\s*thanks?|nah|nope|just\s+the|that.?s\s*(all|it|everything)|nothing\s*else|i.?m\s*(good|fine|ok))\b/i.test(lower);
      if (isDecline) {
        console.log(`[UPSELL_SERVICE_FASTPATH] Decline detected — clearing upsell, moving to timeslot`);
        session.upsellServiceId = undefined;
        session.upsellServiceName = undefined;
        session.upsellServicePrice = undefined;
        session.step = Step.NEED_TIMESLOT;
        await saveSession(conversationId, session);
        // If they also mentioned a day/time, handle it now instead of making them repeat
        const normalizedForDay = normalizeDayTypos(message);
        const hasTimePref = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|morning|afternoon|evening|soonest|earliest|asap)\b/i.test(normalizedForDay) ||
          /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i.test(message);
        if (hasTimePref) {
          console.log(`[UPSELL_SERVICE_FASTPATH] Decline + time pref detected — calling select_timeslot`);
          const toolResult = await handleSelectTimeslot({ preference: normalizedForDay }, session, conversationId);
          const sayMatch = toolResult.match(/Say ONLY:\s*"([\s\S]*?)"\s*and STOP/i) || toolResult.match(/Say:\s*"([\s\S]*?)"/i);
          if (sayMatch) return { content: sayMatch[1].trim(), needsHumanAssistance: false };
        }
        const nameGreet = session.customerNameFirst ? `, ${session.customerNameFirst}` : '';
        return { content: `No problem${nameGreet}! Do you have a date in mind?`, needsHumanAssistance: false };
      }
      // Check if message references a DIFFERENT service (not the one already selected)
      const currentServiceName = (session.upsellServiceName || session.serviceSelectedName || '').toLowerCase();
      const mentionedService = session.servicesAvailable.find((svc: any) => {
        const svcLower = svc.name.toLowerCase();
        // Skip the already-selected service
        if (svcLower === currentServiceName) return false;
        // Match key words from service name (e.g. "brakes" from "Brakes", "full service" from "Full Service")
        const keywords = svcLower.split(/[\s\-\/()]+/).filter((w: string) => w.length > 2 && !/class|car|change|oil|filter|services?/i.test(w));
        return keywords.some((kw: string) => lower.includes(kw));
      });
      if (mentionedService) {
        console.log(`[UPSELL_SERVICE_FASTPATH] Service "${mentionedService.name}" mentioned during upsell — calling select_service`);
        const serviceResult = await handleSelectService({ service_name: mentionedService.name }, session, conversationId);
        const serviceMsg = instructionToCustomerReply(serviceResult);
        await saveSession(conversationId, session);
        return { content: serviceMsg, needsHumanAssistance: false };
      }
    }

    // Fast-path: date/time preference at NEED_SERVICE after upsell decline (service confirmed, step not yet updated)
    // NEED_TIMESLOT is handled by the LLM — it has the slot list + conversation context to pick the right date
    const isAtTimeslotStage =
      (session.step === Step.NEED_SERVICE && !!session.serviceSelectedName && session.timeslotsAvailable?.length > 0 && !isUpsellPending);
    if (isAtTimeslotStage) {
      const lower = message.toLowerCase();
      const normalizedForDay = normalizeDayTypos(message); // fix typos like "Satruday" → "saturday"
      const hasTimePref = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|morning|afternoon|evening|next\s+\w+|\d{1,2}(?:st|nd|rd|th)?|soonest|earliest|asap|any\s*time|don.?t\s*mind|whenever|as\s*soon)\b/i.test(normalizedForDay) ||
        /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i.test(message);
      const isQuestion = message.trim().endsWith('?');
      const isAddService = /\b(add|also|and|plus|as well|too|replace)\b/i.test(lower) && /\b(service|mot|oil|brake|tyre|tire|check|interim|full|wheel|air con|cam belt|battery|wiper|clutch|suspension)\b/i.test(lower);
      if (hasTimePref && !isQuestion && !isAddService) {
        console.log(`[TIMESLOT_FASTPATH] Date/time in "${message}" at ${session.step} — calling select_timeslot directly`);
        const toolResult = await handleSelectTimeslot({ preference: normalizedForDay }, session, conversationId);
        const sayMatch = toolResult.match(/Say ONLY:\s*"([\s\S]*?)"\s*and STOP/i) || toolResult.match(/Say:\s*"([\s\S]*?)"/i);
        if (sayMatch) return { content: sayMatch[1].trim(), needsHumanAssistance: false };
      }
      // Fast-path: add-service during upsell — customer names a service after upsell question
      // LLM often acknowledges verbally instead of calling select_service, so force it here
      if (isAddService) {
        // Extract just the service keyword(s) to avoid fuzzy matcher confusion with filler words
        const serviceKeywords = lower
          .replace(/\b(i'd like to|i would like to|i want to|i need|can you|could you|please|yeah|yes|also|as well|too|and|plus|add|replace|my|the|a|an|get|new|some|do|have|front|rear|back|left|right)\b/gi, '')
          .replace(/\s+/g, ' ').trim();
        // Use the cleaned keywords if they contain something meaningful, otherwise use the matched service word
        const serviceMatch = lower.match(/\b(full service|oil change|oil service|interim service|mot|brake(?:s|pads)?|tyre(?:s)?|tire(?:s)?|wheel alignment|wheel balancing|battery|air con|cam belt|clutch|suspension|wiper|bulb|diagnostic|check)\b/i);
        const serviceIntent = serviceMatch ? serviceMatch[1] : (serviceKeywords || message);
        console.log(`[ADDSERVICE_FASTPATH] Customer wants to add service during upsell: "${message}" → extracted: "${serviceIntent}"`);
        const addResult = await handleSelectService({ service_name: serviceIntent }, session, conversationId);
        const addSayMatch = addResult.match(/Say(?:\s+EXACTLY)?:\s*"([\s\S]*?)"/i);
        if (addSayMatch) {
          await saveSession(conversationId, session);
          return { content: addSayMatch[1].trim(), needsHumanAssistance: false };
        }
        // No Say pattern — return the tool result directly
        console.log(`[ADDSERVICE_FASTPATH] No Say pattern in result — returning raw: ${addResult.slice(0, 100)}`);
        await saveSession(conversationId, session);
        return { content: addResult, needsHumanAssistance: false };
      }
    }

    // Fast-path: at NEED_TIMESLOT, customer mentions a day/time — call select_timeslot directly
    // Without this, "What about Monday?" goes to SIDE_QUESTION_NUDGE and the LLM answers
    // conversationally instead of calling the tool (which is where preferredTime injection lives)
    if (session.step === Step.NEED_TIMESLOT && session.timeslotsAvailable?.length > 0) {
      const normalizedForSlot = normalizeDayTypos(message);
      const hasDayOrTime = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|morning|afternoon|evening|soonest|earliest|asap|any\s*time|don.?t\s*mind|whenever)\b/i.test(normalizedForSlot) ||
        /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i.test(message);
      // Don't intercept pure questions with no scheduling intent like "how long does an MOT take?"
      const hasSchedulingWord = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|morning|afternoon|evening|\d{1,2}\s*(?:am|pm)|soonest|earliest|instead|prefer|rather|how about|what about)\b/i.test(normalizedForSlot);
      if (hasDayOrTime && hasSchedulingWord) {
        console.log(`[TIMESLOT_NEED_FASTPATH] Day/time in "${message}" at need_timeslot — calling select_timeslot directly`);
        const toolResult = await handleSelectTimeslot({ preference: normalizedForSlot }, session, conversationId);
        const sayMatch = toolResult.match(/Say ONLY:\s*"([\s\S]*?)"\s*and STOP/i) || toolResult.match(/Say:\s*"([\s\S]*?)"/i);
        if (sayMatch) return { content: sayMatch[1].trim(), needsHumanAssistance: false };
        // No Say pattern — return raw so customer gets feedback
        console.log(`[TIMESLOT_NEED_FASTPATH] No Say pattern — returning raw: ${toolResult.slice(0, 100)}`);
        return { content: toolResult, needsHumanAssistance: false };
      }
    }

    // Fast-path: slot confirmation — customer is saying yes/no to a proposed slot
    // If step is need_slot_confirm but pending slot is empty (AI asked clarifying question without calling the tool),
    // reset to need_timeslot so the AI treats the reply as a time preference
    if (session.step === Step.NEED_SLOT_CONFIRM && (!session.pendingSlotDate || !session.pendingSlotTime)) {
      console.log('[STATE_GUARD] need_slot_confirm but no pending slot — resetting to need_timeslot');
      session.step = Step.NEED_TIMESLOT;
      await saveSession(conversationId, session);
    }

    // NEED_SLOT_CONFIRM fast-path: catch obvious yes/no at code level so the LLM can't get
    // distracted by long conversation histories (upsell patterns, complaints, etc.)
    if (session.step === Step.NEED_SLOT_CONFIRM && session.pendingSlotDate && session.pendingSlotTime) {
      const lowerMsg = message.trim().toLowerCase().replace(/[^a-z0-9\s]/g, '');
      const isObviousYes = /^(ye+s*|ye+p+|yea+h*|sure|ok(ay)?|go for it|sounds? good|that works|thats? fine|perfect|thatll do|book it|do it|please|fine)(\s+(please|thanks|cheers|ta|mate|thx))*$/i.test(lowerMsg);
      if (isObviousYes) {
        console.log(`[SLOT_CONFIRM_FASTPATH] Obvious yes "${message}" — calling confirm_slot directly`);
        try {
          await ghSetTimeslot(session.sessionId, session.pendingSlotDate, session.pendingSlotTime);
          console.log(`[SLOT_CONFIRM_FASTPATH] ghSetTimeslot succeeded for ${session.pendingSlotDate} at ${session.pendingSlotTime}`);
        } catch (err) {
          console.error('[SLOT_CONFIRM_FASTPATH] ghSetTimeslot failed:', err);
        }
        session.bookingDate = session.pendingSlotDate;
        session.bookingTime = session.pendingSlotTime;
        session.step = Step.NEED_CONTACT;
        session.pendingSlotDate = '';
        session.pendingSlotTime = '';
        await saveSession(conversationId, session);
        const nextAsk = session.contactPhone
          ? (session.contactEmail ? "What's your postcode?" : "Can I grab your email address?")
          : "Can I just grab a contact number?";
        return { content: `Perfect — just need a couple of details to lock that in. ${nextAsk}`, needsHumanAssistance: false };
      }
      // Time/day change at NEED_SLOT_CONFIRM: customer wants a different slot
      // e.g. "Have you got anything around 2pm?" or "Thursday afternoon instead"
      // Only fires when there's a specific time/day/tod — vague rejections ("later") go to LLM
      const normalizedSlotMsg = normalizeDayTypos(message);
      const mentionsTime = /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i.test(message);
      const mentionsTod = /\b(morning|afternoon|evening)\b/i.test(normalizedSlotMsg);
      const mentionsDay = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today)\b/i.test(normalizedSlotMsg);
      if (mentionsTime || mentionsTod || mentionsDay) {
        // If customer only mentions a time/tod but NOT a day, they probably want the same
        // day that was just offered. Inject the pending day name so handleSelectTimeslot
        // picks the right day. e.g. "Do you have 10AM?" after "Friday 8:30am" → "friday 10AM"
        // Strip rejection/filler words so only the scheduling intent reaches matchTimeslot
        // e.g. "No, anything past 5pm?" → "anything past 5pm"
        // e.g. "Not really, I said past 5pm." → "past 5pm"
        let slotPreference = normalizedSlotMsg
          .replace(/^(no+|nope|nah|not really|i said|i already said|i told you)[,.\s!?]*/i, '')
          .replace(/[?.!]+$/g, '')
          .trim();
        if (!slotPreference) slotPreference = normalizedSlotMsg; // safety: don't pass empty string
        if (!mentionsDay && session.pendingSlotDate) {
          const pendingDayName = new Date(session.pendingSlotDate + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long' }).toLowerCase();
          slotPreference = `${pendingDayName} ${slotPreference}`;
          console.log(`[SLOT_REBOOK_FASTPATH] No day mentioned — injecting pending day "${pendingDayName}" → preference: "${slotPreference}"`);
        }
        console.log(`[SLOT_REBOOK_FASTPATH] Time/day change detected in "${message}" at need_slot_confirm — calling select_timeslot`);
        // Clear the pending slot so handleSelectTimeslot treats this as a fresh pick
        session.pendingSlotDate = '';
        session.pendingSlotTime = '';
        session.step = Step.NEED_TIMESLOT;
        await saveSession(conversationId, session);
        const toolResult = await handleSelectTimeslot({ preference: slotPreference }, session, conversationId);
        const sayMatch = toolResult.match(/Say ONLY:\s*"([\s\S]*?)"\s*and STOP/i) || toolResult.match(/Say:\s*"([\s\S]*?)"/i);
        if (sayMatch) return { content: sayMatch[1].trim(), needsHumanAssistance: false };
        // No Say pattern — return the tool result directly so the customer gets feedback
        console.log(`[SLOT_REBOOK_FASTPATH] No Say pattern in tool result — returning raw: ${toolResult.slice(0, 100)}`);
        return { content: toolResult, needsHumanAssistance: false };
      }
      // Side question mid-slot confirm — answer briefly then re-ask confirmation
      if (message.includes('?')) {
        const dateNatural2 = formatDateNaturally(session.pendingSlotDate);
        const timeNatural2 = formatTimeNaturally(session.pendingSlotTime);
        const miniSystemPrompt = buildSystemPromptV2(config, garage.knowledgeDocuments, session);
        const miniMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
          { role: 'system', content: `${miniSystemPrompt}\n\nThe customer asked a question while confirming their slot (${dateNatural2} at ${timeNatural2}). Answer briefly in one sentence, then immediately ask: "Shall I go ahead and book you in for ${dateNatural2} at ${timeNatural2}?" Do NOT call any tools.` },
          { role: 'user', content: message },
        ];
        const miniResp = await getOpenAI().chat.completions.create({ model: 'gpt-4o-mini', temperature: 0.5, max_tokens: 120, messages: miniMessages });
        return { content: miniResp.choices[0].message.content || `Shall I go ahead and book you in for ${dateNatural2} at ${timeNatural2}?`, needsHumanAssistance: false };
      }
    }
    // Non-obvious messages at NEED_SLOT_CONFIRM fall through to LLM (typos, questions, rebooks, etc.)

    // Fast-path: booking already confirmed — handle pleasantries, fall through to LLM for questions
    if (session.step === Step.CONFIRMED || session.step === Step.DONE) {
      const nameGreet = session.customerNameFirst ? ` ${session.customerNameFirst}` : '';
      const msg = message.trim();
      const isPleasantry = /^(thanks|thank you|cheers|great|perfect|brilliant|sounds good|nice|cool|awesome|lovely|wonderful|ok|okay|brill|fab|fantastic)[\s!.]*$/i.test(msg);
      if (isPleasantry) {
        return { content: `You're welcome${nameGreet}! See you then! 👋`, needsHumanAssistance: false };
      }
      // Non-pleasantry messages (questions, requests, complaints) fall through to LLM
      // so the customer gets a real answer instead of being dismissed.
      console.log(`[POST_BOOKING] Non-pleasantry at ${session.step}: "${msg}" — falling through to LLM`);
    }

    // Fast-path: once a timeslot is booked, handle all contact collection locally (no OpenAI)
    // BUT skip this if booking is already confirmed — post-booking messages should go to LLM
    const bookingComplete = !!(session.bookingDate && session.bookingTime);
    const isAlreadyConfirmed = session.step === Step.CONFIRMED || session.step === Step.DONE;
    if ((session.step === Step.NEED_CONTACT || bookingComplete) && !isAlreadyConfirmed) {
      // Ensure step is correct
      if (bookingComplete) {
        session.step = Step.NEED_CONTACT;
      }

      // Check if the message looks like a note/question rather than contact info
      const contactArgs = extractContactArgsFromMessage(message, session);
      const hasContactInfo = contactArgs.phone || contactArgs.email || contactArgs.postcode || contactArgs.houseNumber;

      if (!hasContactInfo) {
        const msg = message.trim();

        // Goodbye/thanks detection — gently redirect to the missing field, or confirm if only house number is left
        const isEndingMsg = /^(bye|goodbye|cheers|thanks|thank you|ta|see you|catch you later|that's it|that's all|all good)[\s!.\u2019]*$/i.test(msg)
          || /\b(cheers|thanks|thank you|bye|ta)[\s!.\u2019]*$/i.test(msg); // also match goodbye at END of message
        if (isEndingMsg) {
          const missingPhone = !session.contactPhone;
          const missingEmail = !session.contactEmail;
          const missingPostcode = !session.contactPostcode;
          // If only house number is left, it's optional — proceed to confirm
          if (!missingPhone && !missingEmail && !missingPostcode) {
            // Set a placeholder house number so handleSetContactInfo proceeds to finalization
            if (!session.contactHouseNumber) session.contactHouseNumber = '-';
            const instructions = await handleSetContactInfo({}, session, conversationId);
            return { content: instructionToCustomerReply(instructions), needsHumanAssistance: false };
          }
          const missing = missingPhone ? 'phone number'
            : missingEmail ? 'email address'
            : 'postcode';
          return { content: `Almost there! I just need your ${missing} to lock in the booking — should be quick!`, needsHumanAssistance: false };
        }

        // House number is optional — if phone+email+postcode are collected and customer
        // sends a non-contact message (decline, question, note), skip house number and proceed
        const waitingForHouseOnly = !!(session.contactPhone && session.contactEmail && session.contactPostcode && !session.contactHouseNumber);
        if (waitingForHouseOnly) {
          // If it looks like a house number (short, starts with digit or is a name), save it
          const looksLikeHouseNum = /^\d/.test(msg) || (msg.length <= 30 && !/\b(no|sorry|can't|cannot|don't|won't|cheers|thanks|bye)\b/i.test(msg) && !msg.includes('?'));
          if (looksLikeHouseNum) {
            (contactArgs as any).houseNumber = msg;
          } else {
            // Not a house number — use placeholder and finalize
            session.contactHouseNumber = '-';
          }
          const instructions = await handleSetContactInfo(contactArgs, session, conversationId);
          return { content: instructionToCustomerReply(instructions), needsHumanAssistance: false };
        }

        const waitingForEmail = !!(session.contactPhone && !session.contactEmail);
        const waitingForPostcode = !!(session.contactPhone && session.contactEmail && !session.contactPostcode);

        // Failed email: has @ but invalid format, OR looks like an email (ends with .com/etc) but missing @
        if (waitingForEmail && (msg.includes('@') || (/\.[a-z]{2,}$/i.test(msg) && !msg.includes(' ')))) {
          return { content: `Hmm, that doesn't look like a valid email address — could you double-check it?`, needsHumanAssistance: false };
        }

        // Failed postcode: short alphanumeric string when we're waiting for a postcode
        // Skip if it's a question — let it fall through to the AI disclosure / question handlers
        if (waitingForPostcode && msg.length <= 15 && !msg.includes('?') && /[A-Z0-9]/i.test(msg) && !/^(yes|no|yeah|nope|ok|okay|thanks|cheers)$/i.test(msg)) {
          (contactArgs as any).postcodeAttempt = msg;
          const instructions = await handleSetContactInfo(contactArgs, session, conversationId);
          return { content: instructionToCustomerReply(instructions), needsHumanAssistance: false };
        }

        // Customer wants to reschedule AFTER confirming — reset booking and restart timeslot selection
        const isRescheduleIntent = /\b(can we (do|change|move|switch|reschedule)|actually.*(want|prefer)|sorry.*(can|could).*(do|change|move)|(change|switch|move) (to|it)|reschedule|no not|not the \d|i said|i meant|i mean (the )?|booking (for|this)|i (want|need).*(friday|saturday|monday|tuesday|wednesday|thursday|sunday|tomorrow|today|\d))\b/i.test(msg);
        const hasDateRef = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|evening|tomorrow|today|\d+(st|nd|rd|th))\b/i.test(msg) || /\b\d{1,2}(st|nd|rd|th)?\b/.test(msg);
        if (isRescheduleIntent && hasDateRef) {
          session.bookingDate = '';
          session.bookingTime = '';
          session.pendingSlotDate = '';
          session.pendingSlotTime = '';
          session.step = Step.NEED_TIMESLOT;
          await saveSession(conversationId, session);
          const toolResult = await handleSelectTimeslot({ preference: msg }, session, conversationId);
          const sayMatch = toolResult.match(/Say ONLY:\s*"([\s\S]*?)"\s*and STOP/i) || toolResult.match(/Say:\s*"([\s\S]*?)"/i);
          if (sayMatch) return { content: sayMatch[1].trim(), needsHumanAssistance: false };
        }

        // Pure digit/phone string — either pre-saved by early scan, or waiting for phone now
        const looksLikeJustPhone = /^\+?[\d\s\-]{7,15}$/.test(msg);
        if (looksLikeJustPhone) {
          if (!session.contactPhone) {
            // Not yet saved — save it directly (accepts non-standard formats like 459694969496)
            session.contactPhone = msg.replace(/[\s\-]/g, '');
            await saveSession(conversationId, session);
          }
          const nextAsk = !session.contactEmail
            ? `Can I grab your email address?`
            : !session.contactPostcode
            ? `What's your postcode?`
            : `What's your house number or name?`;
          return { content: nextAsk, needsHumanAssistance: false };
        }

        // Note request phrased as a question ("Can you also note...", "Could you check...", "Please tell them...")
        // — treat as a note regardless of the question mark
        const isNoteRequest = /\b(can you (also |please )?(note|mention|tell them|check|flag|add|ask them|let them know|make a note)|could you (also |please )?(note|mention|tell them|check|flag)|please (also )?(note|mention|tell them|check|flag|add)|also (note|check|mention|add|flag|tell them)|let them know|make a note)\b/i.test(msg);

        // AI disclosure question — detect even without a "?" (e.g. "is this just AI lol")
        const isAiDisclosure = /\b(is this (ai|a bot|automated|a robot|a computer|artificial)|are you (ai|a bot|a robot|human|real|automated|an ai|a person)|am i talking to (a human|an ai|a bot|a person|a real person|a machine)|just ai|just a bot|talking to a (human|real person|machine)|thought i was talking to|thought you were|you are (a bot|ai|a robot))\b/i.test(msg);
        const fieldNeededForDisclosure = !session.contactPhone ? 'phone number'
          : !session.contactEmail ? 'email address'
          : !session.contactPostcode ? 'postcode'
          : 'house number or name';
        if (isAiDisclosure) {
          const disclosureSysPrompt = buildSystemPromptV2(config, garage.knowledgeDocuments, session);
          const disclosureMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
            { role: 'system', content: `${disclosureSysPrompt}\n\nThe customer is asking whether they're talking to an AI. Be honest in one sentence: acknowledge you're an AI assistant for the garage, reassure them you can help just as well, then immediately re-ask for their ${fieldNeededForDisclosure}. Stay warm and in character. Do NOT say "Hi there!" or restart the conversation. Do NOT call any tools.` },
            ...previousMessages.map(m => ({ role: (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant', content: m.content })),
            { role: 'user', content: msg },
          ];
          const disclosureResp = await getOpenAI().chat.completions.create({ model: 'gpt-4o', temperature: 0.5, max_tokens: 150, messages: disclosureMessages });
          return { content: disclosureResp.choices[0].message.content || `Yes, I'm an AI assistant! I can still get you sorted. Can I grab your ${fieldNeededForDisclosure}?`, needsHumanAssistance: false };
        }

        // Genuine question mid-collection — answer it with OpenAI mini then re-ask for the field
        if (msg.includes('?') && !isNoteRequest) {
          const fieldNeeded = !session.contactPhone ? 'phone number'
            : !session.contactEmail ? 'email address'
            : !session.contactPostcode ? 'postcode'
            : 'house number or name';
          const miniSystemPrompt = buildSystemPromptV2(config, garage.knowledgeDocuments, session);
          const miniMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
            { role: 'system', content: `${miniSystemPrompt}\n\nIMPORTANT: The customer asked a question during contact collection. Answer it briefly (1 sentence max), then immediately re-ask for their ${fieldNeeded}. Be warm and natural. Stay in context — do NOT restart the conversation or say "Hi there!". Do NOT call any tools.` },
            ...previousMessages.map(m => ({ role: (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant', content: m.content })),
            { role: 'user', content: msg },
          ];
          const miniResp = await getOpenAI().chat.completions.create({ model: 'gpt-4o-mini', temperature: 0.5, max_tokens: 120, messages: miniMessages });
          return { content: miniResp.choices[0].message.content || `Could I also grab your ${fieldNeeded}?`, needsHumanAssistance: false };
        }
        // Note or note-request — save it and re-ask for the missing field
        else if (msg.length > 10 && !/^(yes|no|yeah|yep|correct|sure|ok|okay|thanks|cheers)$/i.test(msg)) {
          session.notes = (session.notes ? session.notes + ' | ' : '') + `Customer note: ${msg}`;
          await saveSession(conversationId, session);
          const nextAsk = session.contactPhone
            ? (session.contactEmail ? (session.contactPostcode ? `What's your house number or name?` : `What's your postcode?`) : `Can I grab your email address?`)
            : `Can I just grab a contact number?`;
          return { content: `Got it, I'll make sure the team knows. ${nextAsk}`, needsHumanAssistance: false };
        }
      }

      const instructions = await handleSetContactInfo(contactArgs, session, conversationId);
      return {
        content: instructionToCustomerReply(instructions),
        needsHumanAssistance: false,
      };
    }

    // Build system prompt with state awareness
    const systemPrompt = buildSystemPromptV2(config, garage.knowledgeDocuments, session);

    // Clear warm resume context after prompt is built — only fires on first message after warm resume
    if (session.warmResumeContext) {
      session.warmResumeContext = undefined;
    }

    // Build messages
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
    ];

    const _histTotal = previousMessages.length;
    for (let _i = 0; _i < _histTotal; _i++) {
      const msg = previousMessages[_i];
      const role = msg.role === 'user' ? 'user' : 'assistant';
      // Pass recent customer image attachments to the (vision-capable) model so it can read
      // plates / logbooks / warning lights. Only the last few to avoid re-sending old images.
      if (role === 'user' && _i >= _histTotal - 4) {
        const imgContent = await imageMessageContent(msg);
        if (imgContent) { messages.push({ role: 'user', content: imgContent }); continue; }
      }
      messages.push({ role, content: msg.content });
    }

    // Don't re-append the current turn as a bare image placeholder — the loop already attached the
    // actual image when it's in the persisted history (WhatsApp persists before the agent runs).
    const _lastPrev = previousMessages[previousMessages.length - 1];
    const _curIsImgPlaceholder = ['[Customer sent an image]', '[Image]'].includes(message);
    const _lastPrevIsImg = _lastPrev?.role === 'user' && !!_lastPrev?.mediaType?.startsWith('image/');
    if (!(_curIsImgPlaceholder && _lastPrevIsImg)) {
      messages.push({ role: 'user', content: message });
    }

    // Side-question nudge: when customer asks a question mid-booking, inject a system hint
    // so the LLM answers it instead of repeating the current step's prompt.
    // Only fires at steps where the LLM tends to ignore questions.
    const midBookingSteps: string[] = [Step.NEED_TIMESLOT, Step.NEED_SERVICE, Step.NEED_SLOT_CONFIRM, Step.NEED_CONTACT];
    const looksLikeQuestion = message.trim().endsWith('?') ||
      /\b(how long|how much|what time|what do i need|do (you|i) need|will (you|i|they)|can (you|i)|is (it|there|the)|are (you|there)|does it|when (do|will|is)|where (do|is|are)|what happens|what if|do you do)\b/i.test(message);
    if (midBookingSteps.includes(session.step) && looksLikeQuestion) {
      const stepContext = session.step === Step.NEED_TIMESLOT ? 'asking them for a date/time preference'
        : session.step === Step.NEED_SERVICE ? 'selecting a service'
        : session.step === Step.NEED_SLOT_CONFIRM ? 'confirming their slot'
        : 'collecting their contact details';
      messages.push({
        role: 'system' as any,
        content: `The customer just asked a side question. Answer it helpfully in 1-2 sentences using your knowledge of the garage, then smoothly continue ${stepContext}. Do NOT ignore the question or just repeat the booking prompt.`,
      });
      console.log(`[SIDE_QUESTION_NUDGE] Question detected at ${session.step}: "${message.slice(0, 60)}"`);
    }

    // Call OpenAI with function tools (instruction-based)
    // Slightly higher temperature gives the personality prompt more room to produce natural, varied responses
    const temperature = session.sessionId ? 0.7 : 0.85;

    // Retry wrapper for OpenAI 429 rate limit errors
    // Falls back from gpt-4.1 → gpt-4o on persistent rate limits (gpt-4o has much higher limits)
    const MODEL_PRIMARY = 'gpt-4.1';
    const MODEL_FALLBACK = 'gpt-4o';
    async function openAIWithRetry(msgs: OpenAI.Chat.ChatCompletionMessageParam[], temp: number, tools?: OpenAI.Chat.ChatCompletionTool[]): Promise<OpenAI.Chat.ChatCompletion> {
      let model = MODEL_PRIMARY;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const createParams: any = {
            model,
            messages: msgs,
            temperature: temp,
            max_tokens: 300,
          };
          if (tools) {
            createParams.tools = tools;
            createParams.tool_choice = 'auto';
          }
          return await getOpenAI().chat.completions.create(createParams);
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

    // At confirmed/done, strip booking tools — LLM should only answer questions, not restart flows
    const isPostBooking = session.step === Step.CONFIRMED || session.step === Step.DONE;
    let toolsForCall = isPostBooking ? undefined : getConversationalTools();
    // Human escalation off → no message-taking; drop take_message so the model falls back to the
    // "contact the garage directly" rule in the system prompt instead.
    if (toolsForCall && (config as any).messagingHumanHandoff === false) {
      toolsForCall = toolsForCall.filter((t) => (t as any).function?.name !== 'take_message');
    }

    let response = await openAIWithRetry(messages, temperature, toolsForCall);

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

        // Guard: at NEED_SLOT_CONFIRM, only allow confirm_slot, select_timeslot, and set_contact_info.
        // The LLM sometimes calls select_service here which destroys the booking (overwrites selected service).
        if ((session.step as Step) === Step.NEED_SLOT_CONFIRM && session.pendingSlotDate && session.pendingSlotTime) {
          const allowedAtSlotConfirm = ['confirm_slot', 'select_timeslot', 'set_contact_info', 'take_message'];
          if (!allowedAtSlotConfirm.includes(functionName)) {
            console.log(`[SLOT_CONFIRM_GUARD] Blocked ${functionName} at need_slot_confirm — redirecting to confirm_slot`);
            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: `Wrong tool — you are at the slot confirmation step. The customer was asked to confirm ${session.pendingSlotDate} at ${session.pendingSlotTime}. If they said yes, call confirm_slot. If they want a different time, call select_timeslot. Do NOT call ${functionName}.`,
            });
            continue;
          }
        }

        // Inject price-inquiry flag for select_service — suppresses upsell when customer only wants a price
        // But do NOT suppress upsell when the customer is asking about ADDING a service (bundle, service, etc.)
        if (functionName === 'select_service') {
          const priceSignals = /\bhow much\b|\bwhat.?s the (price|cost)\b|\bjust.*price\b|\bprice.*only\b|\bquote only\b/i;
          const wantsAdditional = /\b(bundle|service|add|extra|also|as well|anything else|full service)\b/i.test(message);
          functionArgs._isPriceInquiry = priceSignals.test(message) && !wantsAdditional;
        }

        // Execute tool and get INSTRUCTIONS for the agent
        const _t0 = Date.now();
        let instructions = '';
        try {
          instructions = await executeConversationalTool(
            functionName,
            functionArgs,
            session,
            conversationId
          );
          logChatToolCall({ conversationId, garageId, agentType: 'automate', toolName: functionName, args: functionArgs, result: instructions, durationMs: Date.now() - _t0 });
        } catch (_e: any) {
          logChatToolCall({ conversationId, garageId, agentType: 'automate', toolName: functionName, args: functionArgs, result: { error: _e?.message || 'tool threw' }, durationMs: Date.now() - _t0 });
          throw _e;
        }

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: instructions,
        });

        // Check immediately after each tool call
        if ((session.step as Step) === Step.NEED_CONTACT) {
          needContactFastPath = true;
        }

        // If select_service (or confirm_vehicle with serviceHint) transitioned to NEED_TIMESLOT, short-circuit
        if ((functionName === 'select_service' || functionName === 'confirm_vehicle') && (session.step as Step) === Step.NEED_TIMESLOT) {
          const sayMatch = instructions.match(/Say(?:\s+EXACTLY)?:\s*"([\s\S]*?)"/i);
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

// Normalise voice-to-text artifacts: word numbers → digits, "at" → @, "dot" → .
function normaliseVoiceToText(text: string): string {
  const wordToDigit: Record<string, string> = {
    zero: '0', oh: '0', o: '0', one: '1', two: '2', three: '3', four: '4',
    five: '5', six: '6', seven: '7', eight: '8', nine: '9',
    double: '', triple: '', // handled below
  };
  let result = text;
  // "double seven" → "77", "triple zero" → "000"
  result = result.replace(/\b(double|triple)\s+(zero|oh|o|one|two|three|four|five|six|seven|eight|nine)\b/gi, (_, mult, digit) => {
    const d = wordToDigit[digit.toLowerCase()] || digit;
    return mult.toLowerCase() === 'double' ? d + d : d + d + d;
  });
  // Single word digits → numbers
  result = result.replace(/\b(zero|oh|one|two|three|four|five|six|seven|eight|nine)\b/gi, (w) => wordToDigit[w.toLowerCase()] || w);
  // Collapse spaces between consecutive digits: "0 7 7 0 0" → "07700"
  result = result.replace(/(\d)\s+(?=\d)/g, '$1');
  // "at" → @ and "dot" → . for emails (only when surrounded by word chars)
  result = result.replace(/\s+at\s+/gi, '@');
  result = result.replace(/\s+dot\s+/gi, '.');
  return result;
}

function extractContactArgsFromMessage(message: string, session: ChatSession): any {
  const args: any = {};
  const text = normaliseVoiceToText(message.trim());

  const emailMatch = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if (!session.contactEmail && emailMatch) {
    args.email = emailMatch[0].toLowerCase();
  }

  const phoneMatches = [...text.matchAll(/\+[\d\s\-]{7,18}|\b0\d[\d\s\-]{8,13}|\b44\d[\d\s\-]{7,12}/g)];
  if (!session.contactPhone && phoneMatches.length > 0) {
    // If customer corrects themselves ("no wait", "actually", "sorry", "wrong number"), use last number
    const hasCorrection = /\b(no wait|actually|sorry|wrong|not that|old number|that.?s wrong|meant to say)\b/i.test(text);
    const chosenPhone = (hasCorrection && phoneMatches.length > 1)
      ? phoneMatches[phoneMatches.length - 1][0]
      : phoneMatches[0][0];
    args.phone = chosenPhone.replace(/\s+/g, '');
  }

  // UK postcode: outward (e.g. CV23, B1, SW1A, W1A) + optional space + inward (digit + 1-2 letters)
  // Crucially the inward section must start with a digit — this prevents VRNs like V20ALA matching
  // Requiring at least 1 trailing letter rejects digit-ending VRN prefixes like BD19, KE18
  const postcodeMatch = text.match(/\b([A-Z]{1,2}\d[\dA-Z]?\s*\d[A-Z]{1,2})\b/i);
  // Reject if it looks like a VRN: letters+digits+letters pattern BUT does NOT end in digit+2letters (inward code)
  // e.g. V20ALA = VRN (ends in ALA not 0AL), cv339bt = postcode (ends in 9BT — digit+2letters ✓)
  const looksLikeVrnPostcode = postcodeMatch &&
    /^[A-Z]{1,3}\d{1,4}[A-Z]{1,3}$/i.test(postcodeMatch[1].replace(/\s/g, '')) &&
    !/\d[A-Z]{2}$/i.test(postcodeMatch[1].replace(/\s/g, ''));
  // Also reject if the candidate is a substring of the known VRN (e.g. KE18 from VRN KE18VBX)
  const partOfVrn = session.vrn && postcodeMatch &&
    session.vrn.replace(/\s/g, '').toUpperCase().includes(postcodeMatch[1].replace(/\s/g, '').toUpperCase());
  const looksLikePostcode = !!postcodeMatch && !looksLikeVrnPostcode && !partOfVrn && postcodeMatch[1].length >= 4;
  if (!session.contactPostcode && looksLikePostcode && postcodeMatch) {
    args.postcode = postcodeMatch[1].replace(/\s+/g, '').toUpperCase();
  }
  // Treat as house number/name once we have postcode (no confirmation step needed)
  const isYes = /^(yes|yeah|yep|yup|correct|sure|ok|okay)$/i.test(text.trim());
  const isNo = /^(no|nope|wrong|incorrect)$/i.test(text.trim());
  // Exclude VRN-like strings (e.g. V20ALA, AB12CDE) — letters+digits+letters but NOT ending in digit+2letters
  const looksLikeVrn = /^[A-Z]{1,3}\d{1,4}[A-Z]{1,3}$/i.test(text.trim()) && !/\d[A-Z]{2}$/i.test(text.trim());

  // Loose postcode attempt — catches malformed postcodes (e.g. "CV2 A35") that fail the strict regex.
  // Used to give "couldn't find that postcode" feedback instead of silently re-asking.
  if (!args.postcode && !session.contactPostcode) {
    const looseMatch = text.match(/\b([A-Z]{1,2}\d[\dA-Z]?\s*[A-Z0-9]{2,3})\b/i);
    if (looseMatch && looseMatch[1].length >= 4 && !looksLikeVrn) {
      args.postcodeAttempt = looseMatch[1];
    }
  }
  const isLikelyHouseNumber = /^[A-Za-z0-9\-\s,\.]{1,40}$/.test(text) &&
    !emailMatch && !phoneMatches.length && !postcodeMatch &&
    !isYes && !isNo && !looksLikeVrn &&
    !/^(thanks|cheers)$/i.test(text.trim());

  // Only capture as house number once we already have postcode saved
  if (!session.contactHouseNumber && session.contactPostcode && isLikelyHouseNumber) {
    // Extract just the house number/name from potentially verbose messages
    // e.g. "yes Manchester, house number 8" → "8"; "it is flat 3" → "flat 3"; "22a" → "22a"
    const hnMatch = text.match(/(?:(?:house|flat|apartment|unit)\s*(?:number|no\.?|num)?\s*(?:is\s*)?)(\d+\s*[a-zA-Z]?|[a-zA-Z]+\s*\d+)/i);
    const numMatch = text.match(/\b(\d+[a-zA-Z]?)\b/);
    args.houseNumber = hnMatch ? hnMatch[1].trim() : (numMatch && text.length > 20 ? numMatch[1] : text);
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
  const sayMatch = instructions.match(/Say(?:\s+EXACTLY)?:\s*"([\s\S]*?)"/i);
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
        name: 'select_branch',
        description: 'Select which branch/location the customer wants to book with (for garages with multiple branches).',
        parameters: {
          type: 'object',
          properties: {
            branch: { type: 'string', description: `Branch name (e.g., ${GARAGE_BRANCHES.map(b => `"${b.name}"`).join(', ') || '"Branch A", "Branch B"'})` },
          },
          required: ['branch'],
        },
      },
    },
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
        name: 'confirm_slot',
        description: 'Customer confirmed the proposed timeslot. Call this to finalise the slot and move to contact collection.',
        parameters: { type: 'object', properties: {}, required: [] },
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
            phone: { type: 'string', description: 'Customer phone number. If the customer corrected themselves (e.g. "no wait", "actually", "wrong number"), use the LAST number they gave, not the first.' },
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
      case 'select_branch':
        return await handleSelectBranch(args, session, conversationId);

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

      case 'confirm_slot': {
        if (!session.pendingSlotDate || !session.pendingSlotTime) {
          return 'No pending slot to confirm. Ask the customer for their preferred date/time.';
        }
        try {
          await ghSetTimeslot(session.sessionId, session.pendingSlotDate, session.pendingSlotTime);
          console.log(`[CONFIRM_SLOT] ghSetTimeslot succeeded for ${session.pendingSlotDate} at ${session.pendingSlotTime}`);
        } catch (err) {
          console.error('[CONFIRM_SLOT] ghSetTimeslot failed:', err);
        }
        session.bookingDate = session.pendingSlotDate;
        session.bookingTime = session.pendingSlotTime;
        session.step = Step.NEED_CONTACT;
        session.pendingSlotDate = '';
        session.pendingSlotTime = '';
        await saveSession(conversationId, session);
        const nextAsk = session.contactPhone
          ? (session.contactEmail ? "What's your postcode?" : "Can I grab your email address?")
          : "Can I just grab a contact number?";
        return `SLOT_CONFIRMED. Say: "Perfect — just need a couple of details to lock that in. ${nextAsk}"`;
      }

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

  return `All contact info is already collected.\nSay: "Thanks, I've got everything I need to confirm this now."\nCall set_contact_info with ZERO SPEECH to finalize.`;
}

// Tool handlers (return instructions like voice agent)

async function handleSelectBranch(args: any, session: ChatSession, conversationId: string): Promise<string> {
  const { branch } = args;

  session.selectedBranch = branch;

  // Set location ID from branches config
  const branchLower = branch.toLowerCase();
  const matched = GARAGE_BRANCHES.find(b => branchLower.includes(b.name.toLowerCase()));
  if (matched) {
    GH_LOCATION_ID = matched.locationId;
  }

  session.step = Step.NEED_NAME;
  await saveSession(conversationId, session);

  console.log(`[SELECT_BRANCH] Branch selected: ${branch}, Location ID: ${GH_LOCATION_ID}`);
  
  return `Branch selected: ${branch}.\n\nSay: "Great! Can I take your name please?"\nWait for their name, then call save_caller_name.`;
}

async function handleSaveCallerName(args: any, session: ChatSession, conversationId: string): Promise<string> {
  let { first_name, last_name = '', intent, service_hint = '' } = args;

  // Strip noise words that creep in when customers type multiple things on one line
  const noiseWords = /\b(quote|booking|book|service|mot|call|please|thanks|hi|hello|hey|for|on|at|a|an|my|me|the|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|evening|today|tomorrow|next|this|week|whatever|wait|sorry|actually|just|now|too|also|both|fine|unknown|there|you|yeah|yes|no|nope|ok|okay|right|sure|great)\b/gi;
  first_name = (first_name || '').replace(noiseWords, '').replace(/\s+/g, ' ').trim();
  last_name = (last_name || '').replace(noiseWords, '').replace(/\s+/g, ' ').trim();

  // Reject clearly bad names: contain digits (VRN-like), suspiciously long, or blank after cleaning
  if (/\d/.test(first_name) || first_name.length > 30) first_name = '';

  if (session.step === Step.NEED_CONTACT) {
    console.log('[STATE_GUARD] Ignoring save_caller_name during NEED_CONTACT');
    return getNextContactInstruction(session);
  }
  
  session.customerNameFirst = first_name;
  session.customerNameLast = last_name;
  session.intent = intent;
  if (service_hint) session.serviceHint = service_hint;
  
  console.log(`[SAVE_NAME] ${first_name} ${last_name}, intent: ${intent}`);
  console.log(`[SAVE_NAME] About to save session...`);
  
  if (intent === 'message') {
    if (session.step !== Step.CONFIRMED && session.step !== Step.DONE) {
      session.step = Step.MESSAGE_ONLY;
    }
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

  // If a vehicle is already on file, ask customer to confirm it rather than silently reusing it
  if (session.vrn && session.vehicleMake && session.vehicleModel) {
    const makeTitle = session.vehicleMake.charAt(0).toUpperCase() + session.vehicleMake.slice(1).toLowerCase();
    const modelTitle = session.vehicleModel.split(' ').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    const greet = firstName ? `Good ${timeGreeting}, ${firstName}!\n\n` : '';
    return `Name saved: ${firstName || '(none)'}. VRN on file: ${session.vrn} (${makeTitle} ${modelTitle}).\n\nSay: "${greet}I have your ${makeTitle} ${modelTitle} (${session.vrn}) on file — is that still the vehicle you'd like to book in?"\nIf yes, call confirm_vehicle with registration="${session.vrn}" confirmed=true. If they give a different reg, call lookup_vehicle with that new reg.`;
  }

  if (!firstName) {
    return `No name provided — do NOT invent or guess a name.\nIntent: ${intent}${service_hint ? ` for ${service_hint}` : ''}.\n\nSay: "Sorry, could I just grab your name?" and wait. When they reply, call save_caller_name again with their name.\nDo NOT call lookup_vehicle until you have a name.`;
  }

  return `Name saved: ${firstName}.\nIntent: ${intent}${service_hint ? ` for ${service_hint}` : ''}.\n\nSay: "Good ${timeGreeting}, ${firstName}! What's your vehicle registration?" — greeting and reg question in ONE response. Wait for registration, then call lookup_vehicle.`;
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
    // Build VRN variant list — try all common misread substitutions at every position
    const regsToTry = [normalized];
    const charSwaps: Record<string, string[]> = {
      // B/V/P — similar shape, common voice/typing misread
      'B': ['V', 'P'], 'V': ['B', 'P'], 'P': ['B', 'V'],
      // 0/O — zero vs letter O
      '0': ['O'], 'O': ['0'],
      // 1/I/L — one vs letter I vs letter L
      '1': ['I', 'L'], 'I': ['1', 'L'], 'L': ['1', 'I'],
    };
    for (let pos = 0; pos < normalized.length; pos++) {
      const ch = normalized[pos];
      if (charSwaps[ch]) {
        for (const alt of charSwaps[ch]) {
          const variant = normalized.slice(0, pos) + alt + normalized.slice(pos + 1);
          if (!regsToTry.includes(variant)) regsToTry.push(variant);
        }
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
              console.log(`[LOOKUP_VEHICLE] Typo auto-fix: ${normalized} → ${tryReg}`);
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

  // Guard: if services are already loaded, don't re-run confirm_vehicle — just tell AI to call select_service
  if (confirmed && session.servicesAvailable && session.servicesAvailable.length > 0 &&
      (session.step === Step.NEED_SERVICE || session.step === Step.NEED_TIMESLOT)) {
    console.log(`[CONFIRM_VEHICLE] Services already loaded (${session.servicesAvailable.length}), skipping re-fetch`);
    const svcList = session.servicesAvailable.map((s: any) => s.name).join(', ');
    return `SERVICES_ALREADY_LOADED: ${svcList}.\nDo NOT call confirm_vehicle again. Ask the customer what service they need, then call select_service with their answer.`;
  }
  
  // Safety guard: if we somehow reached confirm_vehicle without a valid GarageHive sessionId,
  // reset and re-run the vehicle lookup so we get a proper session.
  if (confirmed && !session.sessionId) {
    console.warn(`[CONFIRM_VEHICLE] sessionId is empty — re-running lookup_vehicle for vrn: ${session.vrn}`);
    session.step = Step.NEED_VRN;
    session.vrnConfirmed = false;
    await saveSession(conversationId, session);
    if (session.vrn) {
      return `INTERNAL: sessionId was missing. Call lookup_vehicle(vrn="${session.vrn}") now to re-establish the GarageHive session before proceeding.`;
    }
    return `INTERNAL: sessionId and vrn are both missing. Ask the customer for their vehicle registration again.`;
  }

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
    
    // Save services to DB so the next message can call select_service without re-running confirm_vehicle
    await saveSession(conversationId, session);
    
    if (services.length === 0) {
      return `Vehicle confirmed but no services available.\nSay: "Let me grab your details and we'll give you a call back with a quote."\nThen call take_message.`;
    }
    
    const serviceList = services.slice(0, 5).map((s: any, i: number) => {
      const p = s.price || 0;
      let priceStr = '';
      if (!s.hide_service_prices && p >= 1) {
        if (s.estimate) priceStr = ` — from around £${p}`;
        else if (s.from_price) priceStr = ` — from £${p}`;
        else priceStr = ` — £${p}`;
      }
      return `${i + 1}. ${s.name}${priceStr}`;
    }).join('\n');
    
    // Service hint set — auto-select the service without asking, bypass OpenAI improvisation
    // Split compound hints: "tyre replacement and MOT" → ["tyre replacement", "MOT"]
    if (session.serviceHint) {
      const vehicleGreet = `Perfect! I've got your ${session.vehicleMake} ${session.vehicleModel} on the system.`;
      const hintParts = session.serviceHint.split(/\s+(?:and|&)\s+/i).map((s: string) => s.trim()).filter(Boolean);
      console.log(`[CONFIRM_VEHICLE] serviceHint="${session.serviceHint}" → parts: [${hintParts.join(', ')}]`);

      let primaryResult: string | null = null;
      let secondaryNotes: string[] = [];

      for (const part of hintParts) {
        const result = await handleSelectService({ service_name: part }, session, conversationId);
        if (!primaryResult && !result.startsWith('SERVICE_NOT_AVAILABLE') && !result.startsWith('SERVICE_NOTE_ADDED') && !result.startsWith('NO_SERVICE_MATCH')) {
          primaryResult = result; // first successful match becomes the primary service
        } else if (result.startsWith('SERVICE_NOT_AVAILABLE') || result.startsWith('SERVICE_NOTE_ADDED')) {
          const sayMatch = result.match(/Say:\s*"([\s\S]*?)"/i);
          if (sayMatch) secondaryNotes.push(sayMatch[1].trim());
        }
        // NO_SERVICE_MATCH (ambiguous) — skip silently, primary service still works
      }

      // If no service matched at all, pass through failure
      if (!primaryResult) {
        const fallbackResult = await handleSelectService({ service_name: session.serviceHint }, session, conversationId);
        if (fallbackResult.startsWith('SERVICE_NOT_AVAILABLE') || fallbackResult.startsWith('SERVICE_NOTE_ADDED')) {
          const sayMatch = fallbackResult.match(/Say:\s*"([\s\S]*?)"/i);
          const msg = sayMatch ? sayMatch[1].trim() : fallbackResult;
          console.log(`[CONFIRM_VEHICLE] serviceHint="${session.serviceHint}" — no part matched, passing through`);
          return `VEHICLE_CONFIRMED_SERVICE_UNAVAILABLE.\nSay: "${vehicleGreet}\n\n${msg}"`;
        }
        primaryResult = fallbackResult;
      }

      const slotMsg = instructionToCustomerReply(primaryResult);
      if (secondaryNotes.length > 0) {
        const noteMsg = secondaryNotes.join(' ');
        console.log(`[CONFIRM_VEHICLE] serviceHint="${session.serviceHint}" — compound: primary matched, secondary noted`);
        return `VEHICLE_AND_SERVICE_SET.\nSay: "${vehicleGreet}\n\n${noteMsg}\n\n${slotMsg}"\nWhen the customer picks a slot, call select_timeslot.`;
      }

      console.log(`[CONFIRM_VEHICLE] serviceHint="${session.serviceHint}" — auto-selected service, returning combined instruction`);
      return `VEHICLE_AND_SERVICE_SET.\nSay: "${vehicleGreet}\n\n${slotMsg}"\nWhen the customer picks a slot, call select_timeslot.`;
    }

    const servicePrompt = `Say: "Perfect! I've got your ${session.vehicleMake} ${session.vehicleModel}. What work does it need?"\nWait for their answer, then call select_service with the service name they mention.`;
    return `Vehicle confirmed: ${session.vehicleMake} ${session.vehicleModel}.\n${services.length} services available.\n\nTop services:\n${serviceList}\n\n${servicePrompt}`;
    
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
    // Allow if the customer is requesting a clearly different service
    const requestedNorm = (service_name || '').toLowerCase().replace(/[\s-]/g, '');
    const currentNorm = (session.serviceSelectedName || '').toLowerCase().replace(/[\s-]/g, '');
    const isDifferentService = requestedNorm.length > 2 && !currentNorm.includes(requestedNorm) && !requestedNorm.includes(currentNorm.slice(0, 4));
    if (!isDifferentService) {
      console.log('[STATE_GUARD] select_service called again after service already set — re-presenting timeslots');
      const makeTitle = (session.vehicleMake || '').toLowerCase().split(' ').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      const modelTitle = (session.vehicleModel || '').toLowerCase().split(' ').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      const priceNum = parseFloat(String(session.servicePrice));
      const priceDisplay = (!session.servicePrice || isNaN(priceNum) || priceNum < 1) ? 'POA' : `£${priceNum.toFixed(2).replace(/\.00$/, '')}`;
      return `SERVICE_ALREADY_SET: ${session.serviceSelectedName} (${priceDisplay}).\nSay: "A ${session.serviceSelectedName} for your ${makeTitle} ${modelTitle} is ${priceDisplay}. Do you have a date in mind?"\nWhen the customer responds, call select_timeslot with whatever they say.`;
    }
    // Customer wants a different service — reset but preserve the outbound/original service
    // e.g. "full service instead of brakes" should keep MOT + swap brakes for full service
    const origServiceId = session.serviceSelectedIds?.[0] || session.serviceSelectedId;
    const origServiceName = session.serviceSelectedNames?.[0] || session.additionalServiceName || '';
    // Determine original service price before clearing: in multi-service it's in additionalServicePrice
    // (MOT was the "additional"/first upsell service); in single-service it's in servicePrice
    const origServicePrice = (session.serviceSelectedIds?.length > 1)
      ? (session.additionalServicePrice || session.servicePrice || '')
      : (session.servicePrice || '');
    const hasOriginal = !!(origServiceId && origServiceName);
    console.log(`[STATE_GUARD] Service change: "${session.serviceSelectedName}" → "${service_name}" — resetting, keeping original: ${hasOriginal ? `${origServiceName} £${origServicePrice}` : 'none'}`);
    session.serviceSelectedName = '';
    session.serviceSelectedId = '';
    session.serviceSelectedIds = [];
    session.serviceSelectedNames = [];
    session.servicePrice = '';
    session.additionalServiceName = undefined;
    session.additionalServicePrice = undefined;
    // Preserve the original service as upsellServiceId so handleSelectService combines them
    session.upsellServiceId = hasOriginal ? origServiceId : undefined;
    session.upsellServiceName = hasOriginal ? origServiceName : undefined;
    session.upsellServicePrice = hasOriginal ? origServicePrice : undefined;
    session.step = Step.NEED_SERVICE;
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
  let specialistRan = false;

  if (!matched) {
    const specialistResult = await specialistServiceMatch(effectiveServiceName, session.servicesAvailable);
    specialistRan = true;
    if (specialistResult) {
      matched = specialistResult.service;
      matchReason = specialistResult.reason;
      console.log(`[SERVICE_ADVISOR] Specialist matched: ${matched.name} — ${matchReason}`);
    }
  }

  // ── Service genuinely not available (specialist ran, understood request, but no matching service) ──
  if (!matched && specialistRan) {
    // Sub-path A: Customer already has a service booked (upsell/add-on flow) — add note, continue booking
    if (session.serviceSelectedName && session.timeslotsAvailable?.length > 0) {
      session.notes = (session.notes ? session.notes + ' | ' : '') +
        `Customer also requested: ${service_name} (not available online — needs manual attention)`;
      session.step = Step.NEED_TIMESLOT;
      await saveSession(conversationId, session);
      console.log(`[SELECT_SERVICE] "${service_name}" not available — added as booking note, continuing with ${session.serviceSelectedName}`);
      return `SERVICE_NOTE_ADDED: "${service_name}" is not available as an online booking option, but it has been added as a note to the booking.\nSay: "I don't have ${service_name} as an online booking option, but I've added a note so the team will know to sort that when your car's in. Let's get your ${session.serviceSelectedName} booked — do you have a preferred date in mind?"\nThen call select_timeslot when they give a date.`;
    }

    // Sub-path B: No existing service — offer alternatives or callback
    session.notes = (session.notes ? session.notes + ' | ' : '') +
      `Customer requested: ${service_name} (not available online)`;
    await saveSession(conversationId, session);
    const svcNames = session.servicesAvailable
      .filter((s: any) => !/other|general/i.test(s.name))
      .map((s: any) => cleanServiceName(s.name));
    const svcList = svcNames.slice(0, 4).join(', ');
    console.log(`[SELECT_SERVICE] "${service_name}" not available, no existing service — offering alternatives`);
    if (svcNames.length > 0) {
      return `SERVICE_NOT_AVAILABLE: "${service_name}" is not available as an online booking option. A note has been added.\nSay: "I'm afraid we don't have ${service_name} as an online booking option at the moment. I've made a note so the team can follow up on that. Is there anything else I can help book in? We have ${svcList} available."\nWait for their response — call select_service if they name a service, or take_message if they want a callback.`;
    } else {
      return `SERVICE_NOT_AVAILABLE: "${service_name}" is not available and there are no online alternatives.\nSay: "I'm afraid we don't have ${service_name} as an online booking option. Let me take your details and one of the team will give you a call back to get it sorted."\nThen call take_message.`;
    }
  }

  // ── If still no match (specialist didn't run or direct match failed), ask the customer to clarify ──
  if (!matched) {
    // Find the closest service name to suggest
    const svcNames = session.servicesAvailable
      .filter((s: any) => !/other|general/i.test(s.name))
      .map((s: any) => s.name);
    const suggestion = svcNames.length > 0 ? svcNames[0] : null;

    if (suggestion) {
      const cleanedSuggestion = cleanServiceName(suggestion);
      console.log(`[SELECT_SERVICE] No match for '${effectiveServiceName}' — asking customer to clarify, suggesting: ${cleanedSuggestion}`);
      return `NO_SERVICE_MATCH: "${effectiveServiceName}" didn't match any available service.\nAvailable services: ${svcNames.map(cleanServiceName).join(', ')}.\nSay: "I didn't quite catch that — did you mean a ${cleanedSuggestion}? Or one of these: ${svcNames.slice(0,3).map(cleanServiceName).join(', ')}?"\nWait for their answer, then call select_service again with what they confirm.`;
    } else {
      // No named services at all — ask rather than silently booking "Other"
      console.log(`[SELECT_SERVICE] No match for '${effectiveServiceName}' and no named services — asking customer`);
      return `NO_SERVICE_MATCH: "${effectiveServiceName}" didn't match any available service and there are no named alternatives.\nSay: "I don't have that as a set price right now. Let me take your details and one of the team will give you a call back with a quote."\nThen call take_message.`;
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
    // Step 1: Build service ID list — prepend original service if this is an upsell add-on
    const serviceIdsToSet: string[] = [];
    const upsellAddOnName = (session.upsellServiceId && session.upsellServiceId !== String(serviceId))
      ? session.upsellServiceName : undefined;
    if (session.upsellServiceId && session.upsellServiceId !== String(serviceId)) {
      serviceIdsToSet.push(session.upsellServiceId);
      session.additionalServiceName = session.upsellServiceName;   // retain for ACTIVE SESSION display
      session.additionalServicePrice = session.upsellServicePrice; // retain price for combined total
      session.upsellServiceId = undefined;
      session.upsellServicePrice = undefined;
    }
    serviceIdsToSet.push(String(serviceId));

    // Step 2: Confirm service in GarageHive immediately — price is now real
    await ghSetService(session.sessionId, serviceIdsToSet);

    session.serviceSelectedId = String(serviceId);
    session.serviceSelectedName = cleanServiceName(serviceName);
    session.servicePrice = price;

    // Track all selected services (multi-service bookings)
    // Build from serviceIdsToSet which already includes upsell add-ons
    session.serviceSelectedIds = serviceIdsToSet;
    session.serviceSelectedNames = serviceIdsToSet.map((sid: string) => {
      const svc = session.servicesAvailable.find((s: any) => String(s.service_price_id) === sid);
      return svc ? cleanServiceName(svc.name) : cleanServiceName(serviceName);
    });
    console.log(`[SELECT_SERVICE] Services tracked: ${session.serviceSelectedNames.join(' + ')} (${session.serviceSelectedIds.join(', ')})`);

    // Fetch timeslots right away (needed for both upsell and normal path)
    const timeslots = await ghListTimeslots(session.sessionId);
    session.timeslotsAvailable = timeslots;
    console.log(`[SELECT_SERVICE] Fetched ${timeslots.length} timeslots`);

    if (timeslots.length === 0) {
      // No online timeslots — tell customer and collect contact details
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

    const makeTitle = session.vehicleMake.toLowerCase().split(' ').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const modelTitle = session.vehicleModel.toLowerCase().split(' ').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const priceNum = parseFloat(String(price));
    const priceDisplay = (!price || isNaN(priceNum) || priceNum < 1) ? 'POA' : `£${priceNum.toFixed(2).replace(/\.00$/, '')}`;

    // Quote / price inquiry flow — return price and ask to confirm before booking
    // #177: Also catch price inquiries detected from raw message (not just intent='quote')
    const rawMsgForPrice = (session.lastCustomerMessage || '').toLowerCase();
    const isPriceAsk = session.intent === 'quote' ||
      /\b(how much|what.?s the (price|cost)|price.*for|cost.*of|quote|just.*(the )?(price|cost)|tell me the price)\b/i.test(rawMsgForPrice);
    if (isPriceAsk) {
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

    // Step 3: Upsell — offer once per session, for any service, AFTER it's confirmed in GH
    // Skip if customer already expressed multi-service intent, this is an add-on, or it's drop-off
    // #189: Check BOTH the LLM arg AND the raw customer message for multi-service intent
    const rawMsg = (session.lastCustomerMessage || '').toLowerCase();
    const alreadyWantsMultiple = /\bboth\b|\band\b.*\b(service|mot|full|brakes?|oil)\b|\b(service|mot|full|brakes?|oil)\b.*\band\b|\bas well\b|\btoo\b|\bplus\b|\balso\b/i.test(rawMsg) ||
      /\bboth\b|\bmot.*(?:and|plus).*service|\bservice.*(?:and|plus).*mot/i.test(service_name || '');
    // #177: Detect price inquiry intent — skip upsell when customer is just asking for a price
    const isPriceInquiry = !!(args._isPriceInquiry) ||
      session.intent === 'quote' ||
      /\b(how much|what.?s the (price|cost)|price.*for|cost.*of|quote|just.*(the )?(price|cost)|tell me the price)\b/i.test(rawMsg);
    if (!session.outboundUpsellOffered && !alreadyWantsMultiple && serviceIdsToSet.length === 1 && !isDropOff && !isPriceInquiry) {
      session.outboundUpsellOffered = true;
      session.upsellServiceId = String(serviceId);
      session.upsellServiceName = cleanServiceName(serviceName);
      session.upsellServicePrice = String(price);
      session.step = Step.NEED_SERVICE;  // hold here while upsell pending
      await saveSession(conversationId, session);
      const upsellName = session.customerNameFirst ? `, ${session.customerNameFirst}` : '';
      const priceAnswer = priceDisplay !== 'POA'
        ? `The ${cleanServiceName(serviceName)} for your ${makeTitle} ${modelTitle} is ${priceDisplay}. `
        : '';
      console.log(`[UPSELL] ${serviceName} confirmed in GH — offering upsell`);
      return `UPSELL: ${cleanServiceName(serviceName)} is confirmed in GarageHive. Timeslots are loaded.
Say EXACTLY: "${priceAnswer}No problem${upsellName}! Just while I have you — is there anything else that needs doing whilst the vehicle's in with us?"
IMPORTANT — on the customer's next reply:
- Asked about cost/price/what it would cost (e.g. "what would that cost?", "how much?", "what are my options?", "not sure, what would that cost?") → they're interested! Ask which service: "Were you thinking of a full service, an oil change, or something else?" Do NOT just give the ${cleanServiceName(serviceName)} price again.
- Named ANY service or work they want done (e.g. "full service", "oil change", "tyre replacement", "brake pads", "air con", "wheel alignment", or ANY other work) → ALWAYS call select_service with exactly what they said. Even if it sounds unusual or you're not sure we offer it — ALWAYS call select_service and let the system handle matching. NEVER just acknowledge it verbally without calling the tool.
- If the customer mentions MULTIPLE things (e.g. "tyres and brakes") → call select_service for EACH one separately.
- Said YES but no service named → ask "Which service would you like to add?" and wait.
- Declined / "no thanks" / "just the ${cleanServiceName(serviceName)}" → reply "No problem! Do you have a date in mind?" and call select_timeslot when they give a date or time.
- Declined AND mentioned a date/time in the same message → call select_timeslot with that date/time immediately.
Do NOT call select_service('${cleanServiceName(serviceName)}') again — it's already confirmed.`;
    }

    // Step 4: No upsell (or add-on accepted) — proceed to slot selection
    session.step = Step.NEED_TIMESLOT;
    await saveSession(conversationId, session);

    if (isDropOff) {
      // Drop-off: customer picks a date only, no specific time needed
      const firstDates = [...new Set(timeslots.map((t: any) => t.date))].slice(0, 3)
        .map((d: string) => formatDateNaturally(d)).join(', or ');
      return `SERVICE_SET (DROP-OFF): ${serviceName} (${priceDisplay}).
Say: "A ${serviceName} for your ${makeTitle} ${modelTitle} is ${priceDisplay}. For this one you can ${DROP_OFF_MESSAGE}. The first available date is ${firstDates} — or do you have a particular date in mind?"
When the customer responds, call select_timeslot with whatever they say.`;
    }

    // Combined price display — if there's an add-on, show the total so customer knows what to expect
    let combinedPriceDisplay = priceDisplay;
    if (upsellAddOnName && session.additionalServicePrice) {
      const addOnNum = parseFloat(session.additionalServicePrice);
      const mainNum = parseFloat(String(price));
      if (!isNaN(addOnNum) && addOnNum > 0 && !isNaN(mainNum) && mainNum > 0) {
        combinedPriceDisplay = `£${(mainNum + addOnNum).toFixed(2).replace(/\.00$/, '')}`;
      }
    }
    const alsoMsg = upsellAddOnName
      ? ` I've also got your ${upsellAddOnName} in the same booking.${combinedPriceDisplay !== priceDisplay ? ` Your combined total is ${combinedPriceDisplay}.` : ''}`
      : '';
    return `SERVICE_SET: ${serviceName} (${combinedPriceDisplay !== priceDisplay ? combinedPriceDisplay : priceDisplay}).
Say: "A ${serviceName} for your ${makeTitle} ${modelTitle} is ${priceDisplay}.${alsoMsg} Do you have a date in mind?"
When the customer responds:
- If they name a date or time → call select_timeslot with what they said.
- If they say "soonest", "earliest", "don't mind", "any time" → call select_timeslot('soonest').
- If vague ("next week", "end of month") → ask "Which day works best for you?" without calling select_timeslot yet.`;

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

  return `SLOTS: Available timeslots loaded.
Say: "Do you have a date in mind?"
When the customer responds:
- If they name a date or time → call select_timeslot with what they said.
- If they say "soonest", "earliest", "don't mind", "any time" → call select_timeslot('soonest').
- If vague ("next week", "end of month") → ask "Which day works best for you?" without calling select_timeslot yet.`;
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

  // If upsellServiceId is still set when select_timeslot is called, the upsell window has
  // passed (customer declined or gave date without explicitly accepting). Clear it so we
  // don't accidentally include the declined service in a future select_service call.
  if (session.upsellServiceId) {
    console.log('[SELECT_TIMESLOT] Clearing stale upsellServiceId (upsell window passed)');
    session.upsellServiceId = undefined;
    session.upsellServiceName = undefined;
    session.upsellServicePrice = undefined;
  }

  // If customer gave a time-of-day only (e.g. "afternoon will do") with no day,
  // anchor to their previously stated preferredDate so we don't default to tomorrow.
  const normalizedPref = normalizeDayTypos(preference); // fix typos before day-name checks
  const hasDayInPref = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|\d{1,2}(?:st|nd|rd|th)?)\b/i.test(normalizedPref);
  const hasTodInPref = /\b(morning|afternoon|evening)\b/i.test(normalizedPref);
  let effectivePref = normalizedPref;
  if (hasTodInPref && !hasDayInPref && session.preferredDate) {
    effectivePref = `${session.preferredDate} ${normalizedPref}`;
    console.log(`[SELECT_TIMESLOT] Anchored time-of-day to preferredDate: "${effectivePref}"`);
  }

  // Inverse: day given but no time — inject preferredTime so "Monday instead" carries forward "5pm"
  const hasTimeInPref = /\b(\d{1,2}\s*(?::\d{2})?\s*(?:am|pm)?)\b/i.test(effectivePref) && /\d/.test(effectivePref.match(/\b(\d{1,2})\s*(?::\d{2})?\s*(?:am|pm)?\b/i)?.[1] || '');
  const hasExplicitTime = hasTimeInPref || hasTodInPref; // "morning"/"afternoon" counts as time intent
  if (hasDayInPref && !hasExplicitTime && session.preferredTime) {
    // Inject as "past Xpm" for numeric times, or append period word directly
    const timeLabel = /^\d/.test(session.preferredTime)
      ? `past ${formatTimeNaturally(session.preferredTime)}`
      : session.preferredTime; // "morning", "afternoon", "evening"
    effectivePref = `${effectivePref} ${timeLabel}`;
    console.log(`[SELECT_TIMESLOT] Injected preferredTime: "${effectivePref}" (from saved: ${session.preferredTime})`);
  }

  console.log(`[SELECT_TIMESLOT] Preference: "${effectivePref}", dropOff: ${session.useDropOffBooking}`);
  console.log(`[SELECT_TIMESLOT] Available slots: ${(session.timeslotsAvailable || []).map((t: any) => `${t.date} ${t.time}`).join(', ')}`);

  if (!session.timeslotsAvailable || session.timeslotsAvailable.length === 0) {
    return `No timeslots loaded. Call select_service first.`;
  }

  // Drop-off booking: pick the first slot on the requested date, skip time selection
  if (session.useDropOffBooking) {
    // Try to find a date match from the preference
    const dateMatch = matchTimeslot(effectivePref, session.timeslotsAvailable);
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

  // 'soonest' shortcut — customer doesn't have a preference, auto-pick the earliest slot
  if (/\bsoonest\b|\bearli\w+\b|\bany[\s-]?time\b|\bdon.?t\s*mind\b|\bas\s*soon\b|\bwhenever\b/i.test(effectivePref)) {
    const slot = session.timeslotsAvailable[0];
    session.pendingSlotDate = slot.date;
    session.pendingSlotTime = slot.time;
    session.step = Step.NEED_SLOT_CONFIRM;
    await saveSession(conversationId, session);
    const dateNatural = formatDateNaturally(slot.date);
    const timeNatural = formatTimeNaturally(slot.time);
    console.log(`[SELECT_TIMESLOT] Soonest shortcut — auto-selected ${slot.date} at ${slot.time}`);
    return `Proposed slot: ${dateNatural} at ${timeNatural}.

Say ONLY: "The earliest I have is ${dateNatural} at ${timeNatural} — does that work for you?" and STOP.`;
  }

  // Detect "past X", "after X", "not before X", "X or later" — treat as minimum time filter.
  // Pre-filter timeslotsAvailable so matchTimeslot only sees slots at/after the minimum hour.
  let slotsForMatch = session.timeslotsAvailable;
  const minTimeMatch = effectivePref.match(
    /\b(?:past|after|not before|from)\s+(\d{1,2})(?:[:\.](\d{2}))?\s*(am|pm)?\b|(?:(\d{1,2})(?:[:\.](\d{2}))?\s*(am|pm)\s+or\s+later)/i
  );
  if (minTimeMatch) {
    const rawH = parseInt(minTimeMatch[1] ?? minTimeMatch[4]);
    const rawM = parseInt(minTimeMatch[2] ?? minTimeMatch[5] ?? '0') || 0;
    const mer = (minTimeMatch[3] ?? minTimeMatch[6] ?? '').toLowerCase();
    let minH = rawH;
    if (mer === 'pm' && minH < 12) minH += 12;
    if (mer === 'am' && minH === 12) minH = 0;
    // No am/pm: hours 1-6 are assumed PM for car booking context
    if (!mer && minH >= 1 && minH <= 6) minH += 12;
    const minMinutes = minH * 60 + rawM;
    const filtered = session.timeslotsAvailable.filter((t: any) => {
      const [sh, sm] = t.time.split(':').map(Number);
      return sh * 60 + sm >= minMinutes;
    });
    if (filtered.length > 0) {
      slotsForMatch = filtered;
      console.log(`[SELECT_TIMESLOT] minTime filter: "${effectivePref}" → minH=${minH}:${String(rawM).padStart(2,'0')}, ${filtered.length}/${session.timeslotsAvailable.length} slots remain`);
    } else {
      // No slots at/after the requested time — tell the customer the latest available instead of silently falling back
      const requestedTimeStr = `${minH}:${String(rawM).padStart(2,'0')}`;
      console.log(`[SELECT_TIMESLOT] minTime filter: no slots at/after ${requestedTimeStr} — informing customer`);
      const dayInPref = effectivePref.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i)?.[0]?.toLowerCase();
      const slotsOnDay = dayInPref
        ? session.timeslotsAvailable.filter((t: any) => {
            const dow = new Date(t.date + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long' }).toLowerCase();
            return dow === dayInPref;
          })
        : session.timeslotsAvailable;
      if (slotsOnDay.length > 0) {
        const lastSlot = slotsOnDay[slotsOnDay.length - 1];
        const latestTime = formatTimeNaturally(lastSlot.time);
        const dayDisplay = dayInPref ? formatDateNaturally(slotsOnDay[0].date) : 'that day';
        session.step = Step.NEED_TIMESLOT;
        session.preferredTime = undefined; // time constraint addressed — don't re-inject on next turn
        await saveSession(conversationId, session);
        const requestedTimeNatural = formatTimeNaturally(requestedTimeStr);
        console.log(`[SELECT_TIMESLOT] Cleared preferredTime after NO_MATCH (minTime direct: ${requestedTimeNatural})`);
        return `NO_MATCH: We don't have any slots from ${requestedTimeNatural} onwards. The closest we have on ${dayDisplay} is ${latestTime}.
Say: "We don't have anything from ${requestedTimeNatural} onwards, I'm afraid. The closest I can do on ${dayDisplay} is ${latestTime} — would that work, or would you prefer a different day?"
When they respond, call select_timeslot with whatever they say.`;
      }
      // If no slots on that day at all, fall through to matchTimeslot which will hit NO_MATCH below
    }
  }

  const matched = matchTimeslot(effectivePref, slotsForMatch);

  if (!matched) {
    // If a minimum-time filter was applied and nothing matched, tell the customer what slots exist on that day
    // Use slotsForMatch (filtered by minTime) to only show slots that meet the constraint
    if (minTimeMatch && slotsForMatch.length > 0) {
      const dayInFilter = effectivePref.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i)?.[0]?.toLowerCase();
      if (dayInFilter) {
        const slotsOnDay = slotsForMatch.filter((t: any) => {
          const dow = new Date(t.date + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long' }).toLowerCase();
          return dow === dayInFilter;
        });
        if (slotsOnDay.length > 0) {
          const dayDisplay = formatDateNaturally(slotsOnDay[0].date);
          const nearestSlot = slotsOnDay[slotsOnDay.length - 1]; // latest on that day = closest to requested
          const nearestTime = formatTimeNaturally(nearestSlot.time);
          session.preferredTime = undefined; // time constraint addressed — don't re-inject on next turn
          await saveSession(conversationId, session);
          console.log(`[SELECT_TIMESLOT] Cleared preferredTime after NO_MATCH (minTime matchTimeslot: ${dayInFilter})`);
          return `NO_MATCH: No slots at/after requested time on ${dayInFilter}.
Say: "The closest I can do on ${dayDisplay} is ${nearestTime} — would that work, or would you prefer a different day?"
When they respond, call select_timeslot with whatever they say.`;
        }
      }
    }

    // Detect if this is a time-of-day mismatch on a specific day vs a genuinely unavailable date
    const todInPref = effectivePref.match(/\b(morning|afternoon|evening)\b/i)?.[0]?.toLowerCase();
    const dayInPref = effectivePref.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i)?.[0]?.toLowerCase();
    const isNextWeekDay = dayInPref && /\bnext\b/i.test(effectivePref);

    // "next Friday" with no slots that week — don't confuse with THIS Friday
    if (dayInPref && isNextWeekDay) {
      const dayCapital = dayInPref.charAt(0).toUpperCase() + dayInPref.slice(1);
      const altSpread = formatSlotSpread(session.timeslotsAvailable);
      return `NO_MATCH: No slots next ${dayCapital}.
Say: "I'm afraid our diary doesn't stretch to next ${dayCapital}. The nearest I have is ${altSpread} — would any of those work?"
When they choose, call select_timeslot again.`;
    }

    if (todInPref && dayInPref) {
      // Find slots on that day (nearest occurrence only)
      const slotsOnDay = session.timeslotsAvailable.filter((t: any) => {
        const dow = new Date(t.date + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long' }).toLowerCase();
        return dow === dayInPref;
      });
      if (slotsOnDay.length > 0) {
        const dayDisplay = formatDateNaturally(slotsOnDay[0].date);
        // Pick the nearest slot to the requested time-of-day
        const nearestSlot = todInPref === 'morning' ? slotsOnDay[0] : slotsOnDay[slotsOnDay.length - 1];
        const nearestTime = formatTimeNaturally(nearestSlot.time);
        session.preferredTime = undefined; // time constraint addressed — don't re-inject on next turn
        await saveSession(conversationId, session);
        console.log(`[SELECT_TIMESLOT] Cleared preferredTime after NO_MATCH (tod mismatch: ${todInPref} on ${dayInPref})`);
        return `NO_MATCH: No ${todInPref} slots on ${dayInPref}. Nearest is ${nearestTime}.
Say: "I don't have any ${todInPref} slots on ${dayDisplay}, I'm afraid. The closest I can do is ${nearestTime} — would that work, or would you prefer a different day?"
When they respond, call select_timeslot with whatever they say.`;
      }
    }
    // Exact time + day name — e.g. "11:30am on Friday" but 11:30 doesn't exist on Friday
    const exactTimeInPref = effectivePref.match(/\b(\d{1,2})[:\.](\d{2})\s*(am|pm)?\b/i) ||
                            effectivePref.match(/(?<![\d:])\b(\d{1,2})\s*(am|pm)\b/i);
    const exactDayInPref = effectivePref.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i)?.[0]?.toLowerCase();
    if (exactTimeInPref && exactDayInPref) {
      const slotsOnExactDay = session.timeslotsAvailable.filter((t: any) => {
        const dow = new Date(t.date + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long' }).toLowerCase();
        return dow === exactDayInPref;
      });
      if (slotsOnExactDay.length > 0) {
        const dayDisplay = formatDateNaturally(slotsOnExactDay[0].date);
        // Find nearest slot to the requested exact time
        let reqH = parseInt(exactTimeInPref[1]);
        const reqMer = (exactTimeInPref[3] ?? exactTimeInPref[2] ?? '').toLowerCase();
        if (reqMer === 'pm' && reqH < 12) reqH += 12;
        if (reqMer === 'am' && reqH === 12) reqH = 0;
        const reqMin = reqH * 60 + (parseInt(exactTimeInPref[2] ?? '0') || 0);
        let closest = slotsOnExactDay[0];
        let closestDiff = Infinity;
        for (const s of slotsOnExactDay) {
          const [sh, sm] = s.time.split(':').map(Number);
          const diff = Math.abs(sh * 60 + sm - reqMin);
          if (diff < closestDiff) { closestDiff = diff; closest = s; }
        }
        const nearestTime = formatTimeNaturally(closest.time);
        session.preferredTime = undefined; // time constraint addressed — don't re-inject on next turn
        await saveSession(conversationId, session);
        console.log(`[SELECT_TIMESLOT] Cleared preferredTime after NO_MATCH (exact time on ${exactDayInPref})`);
        return `NO_MATCH: Requested time not available on ${exactDayInPref}. Nearest is ${nearestTime}.
Say: "I don't have that exact time on ${dayDisplay}, I'm afraid. The closest I can do is ${nearestTime} — would that work, or would you prefer a different day?"
When they respond, call select_timeslot with whatever they say.`;
      }
    }
    // Day name with no slots — tell them explicitly (e.g. "we don't have any Sunday slots")
    const dayNameInPref = effectivePref.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i)?.[0];
    if (dayNameInPref) {
      const dayCapital = dayNameInPref.charAt(0).toUpperCase() + dayNameInPref.slice(1).toLowerCase();
      const altSpread = formatSlotSpread(session.timeslotsAvailable);
      return `NO_MATCH: No slots on ${dayCapital}.
Say: "I'm afraid we don't have any slots on ${dayCapital}s. The nearest I have is ${altSpread} — would any of those work?"
When they choose, call select_timeslot again.`;
    }
    // Generic no-match — date unavailable or no recognisable preference
    const lastSlot = session.timeslotsAvailable[session.timeslotsAvailable.length - 1];
    const genericSpread = formatSlotSpread(session.timeslotsAvailable);
    return `NO_MATCH: "${effectivePref}" didn't match any available slot. Online availability ends ${formatDateNaturally(lastSlot.date)}.
Say: "I'm afraid our online diary only goes up to ${formatDateNaturally(lastSlot.date)}. I've got ${genericSpread} available — would any of those work?"
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
  session.slotsShownDate = date; // anchor future bare time replies to this date
  if (!session.preferredDate) session.preferredDate = date; // remember date for "No" fallback
  session.preferredTime = undefined; // slot found — time preference served its purpose
  session.step = Step.NEED_SLOT_CONFIRM;
  console.log(`[SELECT_TIMESLOT] Pending slot set: ${date} at ${time}, waiting for confirmation`);
  await saveSession(conversationId, session);

  const dateNatural = formatDateNaturally(date);
  const timeNatural = formatTimeNaturally(time);

  return `Proposed slot: ${dateNatural} at ${timeNatural}.

Say ONLY: "I've got ${dateNatural} at ${timeNatural} — does that work for you?" and STOP. Do not ask for contact details yet. Wait for them to confirm.`;
}

async function handleSetContactInfo(args: any, session: ChatSession, conversationId: string): Promise<string> {
  const rawPhone: string = args?.phone ?? '';
  const rawEmail: string = args?.email ?? '';
  // Normalise voice-to-text: "oh seven seven..." → "077...", "chris at test dot com" → "chris@test.com"
  const phone: string = normaliseVoiceToText(rawPhone).replace(/\s+/g, '');
  const email: string = normaliseVoiceToText(rawEmail).trim();
  const postcode: string = args?.postcode ?? '';
  const houseNumber: string = args?.houseNumber ?? '';
  
  console.log(`[SET_CONTACT] Args - Phone: ${phone}, Email: ${email}, Postcode: ${postcode}, House: ${houseNumber}`);
  console.log(`[SET_CONTACT] Session step: ${session.step}, Phone: ${session.contactPhone}, Email: ${session.contactEmail}, Postcode: ${session.contactPostcode}, House: ${session.contactHouseNumber}`);
  
  // Guard: do not collect contact info before a service and slot are confirmed
  if (!session.serviceSelectedName && !session.bookingDate) {
    console.log(`[SET_CONTACT] Called before service/slot confirmed — redirecting`);
    return `No service or timeslot confirmed yet. Do NOT collect contact info. Choose one of:\n- If the customer asked to book a specific service → call select_service with that service name\n- If no suitable service is available and they want a callback → call take_message instead`;
  }

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
    if (!/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(email)) {
      console.log(`[SET_CONTACT] Invalid email rejected: ${email}`);
      return `Invalid email format. Say: "That doesn't look like a valid email — could you double-check it?" and wait.`;
    }
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
    const hadAttempt = (postcode && postcode.length > 0) || !!(args as any).postcodeAttempt;
    const msg = hadAttempt
      ? `Hmm, that doesn't look like a valid UK postcode — could you double-check it?`
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
  
  // Guard: don't submit booking if no date/time was confirmed (agent skipped timeslot step)
  if (!session.bookingDate || !session.bookingTime) {
    console.log(`[SET_CONTACT] All contact info collected but NO booking date/time — redirecting to timeslot`);
    session.step = Step.NEED_TIMESLOT;
    await saveSession(conversationId, session);
    return `All contact details saved but no date/time has been confirmed yet. Say: "Great, I've got all your details. Now let's find a time — do you have a preferred date, or shall I suggest the earliest available?"`;
  }

  console.log(`[SET_CONTACT] All info collected, submitting to GH API`);

  try {
    // Submit booking with all required GH fields
    const contactAddress = `${session.contactHouseNumber}, ${session.contactStreet}`.replace(/^,\s*/, '').replace(/,\s*$/, '');
    const result = await ghSetContactInfo(session.sessionId, {
      contact_name: session.customerNameFirst || 'Customer',
      contact_last_name: session.customerNameLast || '',
      contact_email: session.contactEmail,
      contact_number: session.contactPhone,
      contact_address: contactAddress,
      contact_city: session.contactCity,
      contact_postcode: session.contactPostcode,
      contact_salutation: 0,
      contact_address2: '',
      notes: session.notes || '',
      vehicle_mileage: 1,
    });
    
    if (result.status === 'error') {
      console.error('[SET_CONTACT] Booking failed:', result);
      return `Failed to confirm booking: ${result.message || 'Unknown error'}.\nSay: "Sorry ${session.customerNameFirst}, I hit a snag getting that submitted — something went wrong on our end. Please call the garage directly to confirm your slot, or try again and I'll rebook it for you."\nDone.`;
    }
    
    session.step = Step.CONFIRMED;
    await saveSession(conversationId, session);
    
    console.log('[SET_CONTACT] Booking confirmed!');
    
    const dateNatural = formatDateNaturally(session.bookingDate);
    const timeNatural = formatTimeNaturally(session.bookingTime);
    const makeTitle = session.vehicleMake.toLowerCase().split(' ').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const modelTitle = session.vehicleModel.toLowerCase().split(' ').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    
    const confirmedPriceNum = parseFloat(String(session.servicePrice));
    const confirmedPriceDisplay = (!session.servicePrice || isNaN(confirmedPriceNum) || confirmedPriceNum <= 0) ? 'POA' : `£${confirmedPriceNum.toFixed(2).replace(/\.00$/, '')}`;

    // Multi-service display: show all selected services if more than one
    const allServiceNames = session.serviceSelectedNames?.length > 1
      ? session.serviceSelectedNames.join(' + ')
      : session.serviceSelectedName;
    // Calculate combined price for multi-service
    let combinedPrice = confirmedPriceDisplay;
    if (session.serviceSelectedNames?.length > 1 && session.additionalServicePrice) {
      const additionalNum = parseFloat(session.additionalServicePrice);
      if (!isNaN(confirmedPriceNum) && confirmedPriceNum > 0 && !isNaN(additionalNum) && additionalNum > 0) {
        combinedPrice = `£${(confirmedPriceNum + additionalNum).toFixed(2).replace(/\.00$/, '')}`;
      }
    }

    const summary = `✅ Booking confirmed!\n- Customer: ${session.customerNameFirst} ${session.customerNameLast}\n- Vehicle: ${makeTitle} ${modelTitle} (${session.vrn})\n- Service: ${allServiceNames} (${combinedPrice})\n- Date/Time: ${dateNatural} at ${timeNatural}\n- Phone: ${session.contactPhone}\n- Email: ${session.contactEmail}`;

    return `${summary}\n\nSay: "All done! You're booked in for ${dateNatural} at ${timeNatural} for ${allServiceNames}${combinedPrice !== 'POA' ? ` (${combinedPrice})` : ''}. We'll send you a confirmation email. See you then! 👍"\n\nBooking complete - conversation can end naturally.`;
    
  } catch (error: any) {
    console.error('[SET_CONTACT] API error:', error.response?.data || error.message);
    return `API error confirming booking.\nSay: "Sorry ${session.customerNameFirst}, something went wrong on our end and the booking didn't go through. Please call the garage directly to get that slot locked in — really sorry about that!"\nDone.`;
  }
}

async function handleTakeMessage(args: any, session: ChatSession, conversationId: string): Promise<string> {
  const { message, phone, callback_time = '' } = args;
  
  console.log(`[TAKE_MESSAGE] Phone: ${phone}, Message: ${message.substring(0, 50)}...`);
  
  session.message = message;
  session.contactPhone = phone;
  session.preferredCallbackTime = callback_time;
  if (session.step !== Step.CONFIRMED && session.step !== Step.DONE) {
    session.step = Step.MESSAGE_ONLY;
  }
  await saveSession(conversationId, session);

  // Flag conversation as needing attention so it shows up in the Messages inbox
  await prisma.chatConversation.updateMany({
    where: { id: conversationId },
    data: { needsAttention: true },
  });
  void notifyMessaging({ conversationId, event: 'escalated' });
  
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
  if (!sessionId) {
    console.error('[GH_LIST_SERVICES] Called with empty sessionId — aborting');
    throw new Error('GarageHive sessionId is empty — cannot list services');
  }
  const baseUrl = `https://onlinebooking.garagehive.co.uk/api/external-booking/${GH_CUSTOMER_ID}`;
  const headers = {
    'Authorization': `Bearer ${GH_API_KEY}`,
  };
  
  const response = await axios.get(`${baseUrl}/${sessionId}/list-services`, { headers });
  return response.data.services || [];
}

async function ghSetService(sessionId: string, servicePriceId: string | string[]): Promise<any> {
  const baseUrl = `https://onlinebooking.garagehive.co.uk/api/external-booking/${GH_CUSTOMER_ID}`;
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${GH_API_KEY}`,
  };
  const ids = (Array.isArray(servicePriceId) ? servicePriceId : [servicePriceId]).map(Number);

  const response = await axios.post(
    `${baseUrl}/${sessionId}/set-services`,
    { servicePriceIDs: ids },
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
    // If specialist said "Other"/"General", the requested service genuinely doesn't exist — return null
    // so the caller can use the SERVICE_NOT_AVAILABLE graceful path instead of silently booking "Other Option"
    const slCheck = svcName.toLowerCase();
    if (slCheck === 'other' || slCheck === 'general') {
      console.log(`[SERVICE_ADVISOR] Specialist returned "${svcName}" — service not available: ${reason}`);
      return null;
    }
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

  // Fuzzy match — find the service whose name is closest by edit distance
  // Returns the best match only if it's close enough (distance <= 40% of the longer string)
  function levenshtein(a: string, b: string): number {
    const m = a.length, n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
      }
    }
    return dp[m][n];
  }

  // Compare query against each word in service names, and also full service names
  let bestFuzzy: any = null;
  let bestFuzzyDist = Infinity;
  const queryWords = queryLower.split(/\s+/);
  for (const service of services) {
    const sn = service.name.toLowerCase();
    // Full name distance
    const fullDist = levenshtein(queryLower, sn);
    // Word-level: best distance between any query word and any service name word
    // Only count word pairs where distance is small relative to WORD length (not full query)
    // This prevents "tyre" vs "car" (dist 3, threshold 1) from matching
    const snWords = sn.split(/\s+/);
    const wordDist = Math.min(...queryWords.flatMap(qw => snWords.map((sw: string) => {
      const d = levenshtein(qw, sw);
      const maxWordLen = Math.max(qw.length, sw.length);
      const wordThreshold = Math.max(1, Math.floor(maxWordLen * 0.3));
      return d <= wordThreshold ? d : Infinity; // reject if too far for this word pair
    })));
    const dist = Math.min(fullDist, wordDist);
    if (dist < bestFuzzyDist) {
      bestFuzzyDist = dist;
      bestFuzzy = service;
    }
  }
  // Accept fuzzy match if distance is small relative to query length (max 2 edits per word, or 40% of full query)
  const threshold = Math.max(2, Math.floor(queryLower.length * 0.4));
  if (bestFuzzy && bestFuzzyDist <= threshold) return bestFuzzy;

  return null;
}

function formatDateNaturally(dateStr: string): string {
  const date = new Date(dateStr + 'T12:00:00'); // noon to avoid DST edge cases

  // Get UK local today/tomorrow using Intl (avoids UTC midnight / DD/MM parse bugs)
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const pm: Record<string, string> = {};
  for (const p of parts) pm[p.type] = p.value;
  const ukToday = new Date(parseInt(pm.year), parseInt(pm.month) - 1, parseInt(pm.day));
  const ukTomorrow = new Date(ukToday);
  ukTomorrow.setDate(ukToday.getDate() + 1);

  const dateOnly = dateStr.split('T')[0];
  const todayStr = `${ukToday.getFullYear()}-${String(ukToday.getMonth()+1).padStart(2,'0')}-${String(ukToday.getDate()).padStart(2,'0')}`;
  const tomorrowStr = `${ukTomorrow.getFullYear()}-${String(ukTomorrow.getMonth()+1).padStart(2,'0')}-${String(ukTomorrow.getDate()).padStart(2,'0')}`;
  
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

// Concise slot spread — dates only (no times) for WhatsApp brevity
// e.g. "tomorrow, Saturday, or Monday" instead of "tomorrow at 8:30am, or Saturday 16th May at 11:30am, or Monday 18th May at 8:30am"
function formatSlotSpread(slots: any[], maxDates = 3): string {
  const seenDates = new Set<string>();
  const picked: any[] = [];
  for (const t of slots) {
    if (!seenDates.has(t.date)) {
      seenDates.add(t.date);
      picked.push(t);
      if (picked.length >= maxDates) break;
    }
  }
  if (picked.length === 0) return 'no available slots';
  if (picked.length === 1) return formatDateNaturally(picked[0].date);
  const last = picked.pop()!;
  return picked.map(t => formatDateNaturally(t.date)).join(', ') + ', or ' + formatDateNaturally(last.date);
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

// Strip GH API's " - component1 / component2 / ..." suffix from service names
function cleanServiceName(name: string): string {
  const dashIdx = name.indexOf(' - ');
  if (dashIdx > 0 && name.substring(dashIdx + 3).includes(' / ')) {
    return name.substring(0, dashIdx).trim();
  }
  return name;
}

function formatSlotsAsNumberedList(timeslots: any[], max = 3): string {
  return timeslots.slice(0, max).map((t: any, i: number) =>
    `${i + 1}. ${formatDateNaturally(t.date)} at ${formatTimeNaturally(t.time)}`
  ).join('\n');
}

function matchTimeslot(preference: string, timeslots: any[]): any | null {
  if (!timeslots || timeslots.length === 0) return null;

  const prefLower = normalizeDayTypos(preference.toLowerCase().trim());

  // Extract a time-of-day hour from text — only matches valid hours (0-23) with am/pm,
  // or HH:MM format. Ignores bare numbers that could be day-of-month (e.g. "25th").
  function extractPrefHour(text: string): number | null {
    // HH:MM or HH.MM optionally followed by am/pm — e.g. "1:30pm"→13, "1.30"→13, "9:30am"→9, "13:30"→13
    const hhmm = text.match(/\b(\d{1,2})[:\.](\d{2})\s*(am|pm)?\b/i);
    if (hhmm) {
      let h = parseInt(hhmm[1]);
      const mer = (hhmm[3] || '').toLowerCase();
      // No am/pm: hour < 7 with minutes → assume PM (e.g. "1.30" → 13:30, not 01:30)
      if (!mer && h >= 1 && h <= 6) h += 12;
      if (mer === 'pm' && h < 12) h += 12;
      if (mer === 'am' && h === 12) h = 0;
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
    // Bare number with no am/pm and no colon — e.g. "tomorrow at 1", "around 3"
    // Hours 1-6 are assumed PM (nobody books a car at 1am), 7-11 assumed AM, 12 = noon
    const bare = text.match(/\bat\s+(\d{1,2})\b(?!\s*[:apm])/i) || text.match(/\baround\s+(\d{1,2})\b(?!\s*[:apm])/i);
    if (bare) {
      let h = parseInt(bare[1]);
      if (h >= 1 && h <= 6) h += 12; // 1→13, 2→14, ... 6→18
      if (h >= 7 && h <= 11) { /* stays as-is: 7am–11am */ }
      if (h === 12) { /* stays 12: noon */ }
      if (h >= 0 && h <= 23) return h;
    }
    // Time-of-day keywords — morning/afternoon/evening
    if (/\bmorning\b/.test(text)) return 9;
    if (/\bafternoon\b/.test(text)) return 14;
    if (/\bevening\b/.test(text)) return 17;
    return null; // Don't extract bare numbers — they're probably dates
  }

  // Time-of-day range check — when preference uses a keyword (morning/afternoon/evening),
  // the matched slot must actually fall within that time band, not just be "closest".
  function isInTodRange(slotHour: number, prefText: string): boolean {
    if (/\bmorning\b/.test(prefText)) return slotHour >= 6 && slotHour < 12;
    if (/\bafternoon\b/.test(prefText)) return slotHour >= 12 && slotHour < 18;
    if (/\bevening\b/.test(prefText)) return slotHour >= 17;
    return true; // no keyword — any hour is fine
  }

  // Extract exact minutes from preference (e.g. "11:30am" → {h:11, m:30})
  function extractExactTime(text: string): { h: number; m: number } | null {
    const hhmm = text.match(/\b(\d{1,2})[:\.](\d{2})\s*(am|pm)?\b/i);
    if (hhmm) {
      let h = parseInt(hhmm[1]);
      const min = parseInt(hhmm[2]);
      const mer = (hhmm[3] || '').toLowerCase();
      if (!mer && h >= 1 && h <= 6) h += 12;
      if (mer === 'pm' && h < 12) h += 12;
      if (mer === 'am' && h === 12) h = 0;
      if (h >= 0 && h <= 23) return { h, m: min };
    }
    return null;
  }

  function closestByTime(candidates: any[], prefHour: number | null): any {
    // When a time-of-day keyword is used, filter to slots within that range FIRST —
    // even if there's only one candidate, it must pass the range check
    const hasTodKeyword = /\b(morning|afternoon|evening)\b/.test(prefLower);
    if (hasTodKeyword) {
      const inRange = candidates.filter(t => isInTodRange(parseInt(t.time.split(':')[0]), prefLower));
      if (inRange.length === 0) return null; // no slots in the requested time band
      if (prefHour === null || inRange.length === 1) return inRange[0];
      return inRange.reduce((best, t) => {
        const tH = parseInt(t.time.split(':')[0]);
        const bH = parseInt(best.time.split(':')[0]);
        return Math.abs(tH - prefHour) <= Math.abs(bH - prefHour) ? t : best;
      });
    }
    // When an exact time is specified (e.g. "11:30am"), only match within 1 hour
    // Prevents "11:30am on Friday" from matching 8:30am when 11:30 doesn't exist
    const exactTime = extractExactTime(prefLower);
    if (exactTime) {
      const prefMinTotal = exactTime.h * 60 + exactTime.m;
      const close = candidates.filter(t => {
        const [sh, sm] = t.time.split(':').map(Number);
        return Math.abs(sh * 60 + sm - prefMinTotal) <= 60;
      });
      if (close.length === 0) return null; // no slot close enough to the exact requested time
      return close.reduce((best: any, t: any) => {
        const [th, tm] = t.time.split(':').map(Number);
        const [bh, bm] = best.time.split(':').map(Number);
        return Math.abs(th * 60 + tm - prefMinTotal) <= Math.abs(bh * 60 + bm - prefMinTotal) ? t : best;
      });
    }
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

  // "Later", "after that", "something later", "end of the week"
  // "later" is relative — if the customer was just shown a specific date, offer later on
  // that same day first. Only jump to a different day if no later slots exist on that day.
  if (/\b(later|after that|end of|something later)\b/.test(prefLower)) {
    const ph = extractPrefHour(prefLower);
    if (ph !== null) return closestByTime(timeslots, ph) ?? timeslots[timeslots.length - 1];
    return timeslots[timeslots.length - 1];
  }
  // "Next month", "further out" — outside our booking window; return null so LLM explains
  if (/\b(next month|further out)\b/.test(prefLower)) {
    return null;
  }

  // "Today" / "Tomorrow" — use UK local date to avoid UTC midnight boundary issues
  // e.g. at 11:30pm UTC the UTC date is still "yesterday" but UK date is already "today"
  function ukDateStr(offsetDays = 0): string {
    const now = new Date();
    // Use Intl.DateTimeFormat to get UK date parts directly — avoids DD/MM/YYYY parse ambiguity
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now);
    const partMap: Record<string, string> = {};
    for (const p of parts) partMap[p.type] = p.value;
    // Construct a date at midnight UK time using explicit year/month/day
    const ukDate = new Date(parseInt(partMap.year), parseInt(partMap.month) - 1, parseInt(partMap.day));
    ukDate.setDate(ukDate.getDate() + offsetDays);
    const y = ukDate.getFullYear();
    const m = String(ukDate.getMonth() + 1).padStart(2, '0');
    const d = String(ukDate.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  if (/\btoday\b/.test(prefLower)) {
    const matches = timeslots.filter(t => t.date === ukDateStr(0));
    if (matches.length > 0) {
      const ph = extractPrefHour(prefLower);
      const best = closestByTime(matches, ph);
      if (!best) return null; // no slots in requested time band
      // If a specific time was requested but the best slot is >3h away, return null so AI explains
      if (ph !== null && Math.abs(parseInt(best.time.split(':')[0]) - ph) > 3) return null;
      return best;
    }
    return null; // today specified but no today slots — let OpenAI explain
  }
  if (/\btomorrow\b/.test(prefLower)) {
    const matches = timeslots.filter(t => t.date === ukDateStr(1));
    if (matches.length > 0) {
      const ph = extractPrefHour(prefLower);
      const best = closestByTime(matches, ph);
      if (!best) return null; // no slots in requested time band
      // If a specific time was requested but the best slot is >3h away, return null so AI explains
      if (ph !== null && Math.abs(parseInt(best.time.split(':')[0]) - ph) > 3) return null;
      return best;
    }
    return null; // tomorrow specified but no tomorrow slots — let OpenAI explain
  }

  // "Next week"
  if (/\bnext week\b/.test(prefLower)) {
    const nextWeekStr = ukDateStr(7);
    const matches = timeslots.filter(t => t.date >= nextWeekStr);
    if (matches.length > 0) return closestByTime(matches, extractPrefHour(prefLower));
    return null; // next week specified but no slots that far out — let NO_MATCH explain
  }

  // Named day — with "next" prefix means skip to the week AFTER the coming occurrence
  // e.g. today=Sunday 23 Feb, "next thursday" = 5 Mar (not 26 Feb which is "this thursday")
  const dayNames = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const isNext = /\bnext\b/.test(prefLower);
  for (const dayName of dayNames) {
    if (new RegExp(`\\b${dayName}\\b`).test(prefLower)) {
      const ukNow = (() => {
        const now = new Date();
        const parts = new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
        }).formatToParts(now);
        const pm: Record<string, string> = {};
        for (const p of parts) pm[p.type] = p.value;
        return new Date(parseInt(pm.year), parseInt(pm.month) - 1, parseInt(pm.day));
      })();
      const todayDow = ukNow.getDay(); // 0=Sun
      const targetDow = dayNames.indexOf(dayName);

      // How many days until the next occurrence of targetDow
      let daysUntil = (targetDow - todayDow + 7) % 7;
      const wasSameDay = daysUntil === 0;
      if (daysUntil === 0) daysUntil = 7; // "thursday" when today is thursday = next week

      // "next thursday" skips past the coming one to the one after
      // but only if it wasn't already the same day (which was bumped from 0→7 above)
      if (isNext && !wasSameDay && daysUntil < 7) daysUntil += 7;

      const target = new Date(ukNow);
      target.setDate(ukNow.getDate() + daysUntil);
      const y = target.getFullYear();
      const mo = String(target.getMonth() + 1).padStart(2, '0');
      const dy = String(target.getDate()).padStart(2, '0');
      const targetDateStr = `${y}-${mo}-${dy}`;

      // Find slots on that exact date only — do NOT fall back to next available
      // If Friday is requested but not available, return null so NO_MATCH explains it
      let matches = timeslots.filter(t => t.date === targetDateStr);
      if (matches.length === 0) return null;
      // If customer said e.g. "Saturday 16th", narrow to slot where day-of-week AND day-of-month both match.
      // Without this, "Saturday 16th" would return the nearest Saturday (could be the 9th).
      const domRefine = prefLower.match(/\b(\d{1,2})(st|nd|rd|th)\b/);
      if (domRefine) {
        const dayNum = parseInt(domRefine[1]);
        const refined = timeslots.filter(t => {
          const d = new Date(t.date + 'T12:00:00');
          return d.getDay() === targetDow && d.getDate() === dayNum;
        });
        if (refined.length > 0) {
          const ph = extractPrefHour(prefLower);
          const best = closestByTime(refined, ph);
          if (!best) return null; // no slots in requested time band
          if (ph !== null && Math.abs(parseInt(best.time.split(':')[0]) - ph) > 3) return null;
          return best;
        }
        // Ordinal mentioned but no slot on that Saturday-the-Nth — fall through to nearest Saturday
      }
      if (matches.length > 0) {
        const ph = extractPrefHour(prefLower);
        const best = closestByTime(matches, ph);
        if (!best) return null; // no slots in requested time band
        // Only apply ">3h" guard when matching exact day (not falling through to a different date)
        const isExactDay = matches[0]?.date === targetDateStr;
        if (ph !== null && isExactDay && Math.abs(parseInt(best.time.split(':')[0]) - ph) > 3) return null;
        return best;
      }
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

function buildSystemPromptV2(config: any, knowledgeDocuments: any[], session: ChatSession): string {
  const branchName = config.branchName || 'our garage';
  const agentName = (config.agentName || '').trim() || 'Leah';

  // ── Persona ──────────────────────────────────────────────────────────────
  let prompt = `You are ${agentName}, the friendly AI receptionist at ${branchName}, a British car repair garage.
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
- If asked "are you AI?", "is this a bot?", "am I talking to a human?", or similar: be honest in one sentence — acknowledge you're an AI assistant for ${branchName} and that you can still help — then immediately continue with whatever you were doing. Never deny being AI. Never restart the conversation mid-booking.

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

  // ── Per-garage config: custom rules, FAQs, smart questions ───────────────
  // Parity with the voice agents so a garage configures once (Agent Setup) for chat + voice.
  // Shape-safe: customRules may be an array of {text,active} OR an object (branch config) — only
  // render the array form.
  const _rules = Array.isArray(config.customRules)
    ? config.customRules
        .filter((r: any) => r && typeof r === 'object' && r.active === true && (r.text || '').trim())
        .map((r: any) => `- ${String(r.text).trim()}`)
    : [];
  if (_rules.length > 0) {
    prompt += `RULES YOU MUST FOLLOW (these override anything else in this prompt):\n${_rules.join('\n')}\n\n`;
  }

  const _faqs = Array.isArray(config.faqs)
    ? config.faqs
        .filter((f: any) => f && (f.question || f.q) && (f.answer || f.a))
        .map((f: any) => `Q: ${String(f.question || f.q).trim()}\nA: ${String(f.answer || f.a).trim()}`)
    : [];
  if (_faqs.length > 0) {
    prompt += `COMMON QUESTIONS — answer from these when a customer asks something similar; do NOT invent an answer:\n${_faqs.join('\n')}\n\n`;
  }

  const _fields = Array.isArray(config.dataCollectionFields)
    ? config.dataCollectionFields
        .filter((f: any) => f && f.active === true && (f.label || f.key))
        .map((f: any) => {
          const label = String(f.label || f.key).trim();
          const tag = f.required ? '(required)' : '(only if relevant)';
          const instr = (f.instruction || '').trim() ? ` — ${String(f.instruction).trim()}` : '';
          return `- ${label} ${tag}${instr}`;
        })
    : [];
  if (_fields.length > 0) {
    prompt += `INFORMATION TO COLLECT during the chat (ask naturally, one at a time, don't interrogate):\n${_fields.join('\n')}\n\n`;
  }

  // ── Key behaviour rules around opening hours ─────────────────────────────
  prompt += `OPENING HOURS BEHAVIOUR:
- You can take bookings at ANY time of day — you are always available.
- Only mention opening hours if the customer specifically asks about them.
- If the customer asks to speak to a human/agent/someone, say: "Unfortunately the team are currently outside of office hours, but I can take a message and they'll be in touch during opening hours${openingHoursSummary ? ` (${openingHoursSummary})` : ''}. What would you like to pass on?" Then call take_message.\n\n`;

  // ── Warm resume context — customer returning after a gap ──────────────────
  if (session.warmResumeContext) {
    prompt += `\nWARM RESUME: This customer was previously chatting about a booking but went quiet for a while. ${session.warmResumeContext}\n`;
    prompt += `Acknowledge the gap briefly ("Welcome back!" or "Hi again!"), remind them what they were looking at, and ask if they'd like to continue.\n`;
    prompt += `If they had a vehicle (shown below in CURRENT STATE), say something like "Shall we pick up where we left off with your [vehicle]?"\n`;
    prompt += `If they say yes, call lookup_vehicle with their registration to reload the vehicle, then proceed to service selection.\n`;
    prompt += `If they say no or want something different, start fresh from service selection.\n`;
    prompt += `Do NOT re-ask for their name or registration — you already have these.\n\n`;
  }

  // ── Current booking state ─────────────────────────────────────────────────
  prompt += `CURRENT STATE: ${session.step}\n`;
  if (session.customerNameFirst) prompt += `Customer: ${session.customerNameFirst} ${session.customerNameLast || ''}\n`;
  if (session.vrn) prompt += `Vehicle: ${session.vehicleMake} ${session.vehicleModel} (${session.vrn})\n`;
  if (session.serviceSelectedName) {
    const spNum = parseFloat(String(session.servicePrice));
    const spDisplay = (!session.servicePrice || isNaN(spNum) || spNum < 1) ? 'POA' : `£${spNum.toFixed(2).replace(/\.00$/, '')}`;
    prompt += `Service: ${session.serviceSelectedName} (${spDisplay})\n`;
  }
  if (session.bookingDate) prompt += `Slot: ${session.bookingDate} at ${session.bookingTime}\n`;

  // ── ACTIVE SESSION guards — tell the LLM exactly what's already collected ──
  // CRITICAL: LLM must not re-ask for anything listed here
  const hasActiveSession = !!(session.vrn || session.serviceSelectedName || session.bookingDate || session.contactPhone || session.customerNameFirst);
  if (hasActiveSession) {
    const makeTitle = (session.vehicleMake || '').toLowerCase().split(' ').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const modelTitle = (session.vehicleModel || '').toLowerCase().split(' ').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    prompt += `\nACTIVE SESSION — CRITICAL: do NOT ask for or re-fetch anything already listed here. Never ask for name, VRN, or service again if they appear below:\n`;
    if (session.vrn) {
      prompt += `- Vehicle: ${session.vrn} (${makeTitle} ${modelTitle}) — confirmed ✓ do NOT call lookup_vehicle or confirm_vehicle again\n`;
    }
    if (session.serviceSelectedName) {
      const priceNum = parseFloat(String(session.servicePrice));
      const addlPriceNum = parseFloat(String(session.additionalServicePrice));
      const hasAddlPrice = session.additionalServicePrice && !isNaN(addlPriceNum) && addlPriceNum > 0;
      const totalNum = (!isNaN(priceNum) && priceNum > 0 && hasAddlPrice) ? priceNum + addlPriceNum : priceNum;
      const priceDisplay = (!session.servicePrice || isNaN(priceNum) || priceNum < 1) ? '' : ` (£${priceNum.toFixed(2).replace(/\.00$/, '')})`;
      const totalDisplay = (hasAddlPrice && !isNaN(priceNum) && priceNum > 0) ? ` — combined total £${totalNum.toFixed(2).replace(/\.00$/, '')}` : '';
      const additionalSvc = session.additionalServiceName
        ? ` + ${session.additionalServiceName}${hasAddlPrice ? ` (£${addlPriceNum.toFixed(2).replace(/\.00$/, '')})` : ''}` : '';
      prompt += `- Service: ${session.serviceSelectedName}${additionalSvc}${priceDisplay}${totalDisplay} — confirmed in GH ✓ do NOT call select_service again UNLESS the customer explicitly asks to add another service\n`;
      if (session.additionalServiceName && !session.bookingDate && session.step === Step.NEED_SERVICE) {
        const combinedPriceNote = totalDisplay ? ` The combined total is £${totalNum.toFixed(2).replace(/\.00$/, '')}.` : '';
        prompt += `IMPORTANT: When first asking for a date this turn, open with a brief combined booking confirmation — e.g. "So I've got ${session.serviceSelectedName} and ${session.additionalServiceName} both locked in for your ${makeTitle} ${modelTitle}.${combinedPriceNote}" — then ask for the date.\n`;
      }
    }
    if (session.timeslotsAvailable?.length > 0 && !session.bookingDate) {
      prompt += `- Timeslots: already fetched (${session.timeslotsAvailable.length} available) — call select_timeslot with the customer's date or time preference. If the customer explicitly asks to add another service, call select_service with that service name first.\n`;
    }
    if (session.preferredDate) {
      prompt += `- Customer's preferred date: "${session.preferredDate}" — if they say "No" or ask for alternatives, call select_timeslot with this date + their time preference\n`;
    }
    if (session.bookingDate && session.bookingTime) {
      prompt += `- Slot: ${session.bookingDate} at ${session.bookingTime} — confirmed ✓ do NOT ask for date/time again\n`;
    }
    if (session.customerNameFirst) {
      prompt += `- Customer name: ${session.customerNameFirst}${session.customerNameLast ? ' ' + session.customerNameLast : ''} — CONFIRMED ✓ NEVER ask for the customer's name again\n`;
    }
    if (session.contactPhone) {
      prompt += `- Phone: ${session.contactPhone} — already collected, do NOT ask again\n`;
    }
    if (session.contactEmail) {
      prompt += `- Email: ${session.contactEmail} — already collected, do NOT ask again\n`;
    }
    if (session.contactPostcode) {
      prompt += `- Postcode: ${session.contactPostcode} — already collected, do NOT ask again\n`;
    }
    prompt += `\n`;
  }

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
    prompt += `ONLY if the customer explicitly asks "what are the options", "what services do you offer", or "what are the prices", list these services with their prices naturally. Otherwise, when you reach the service selection step, just ask naturally what they need (e.g., "What sort of service were you after?") without listing everything — wait for them to tell you.\n`;
  }

  // ── Available timeslots — inject when in timeslot selection so OpenAI can handle any natural language ──
  if (session.step === Step.NEED_TIMESLOT && session.timeslotsAvailable && session.timeslotsAvailable.length > 0) {
    const slotLines = session.timeslotsAvailable.map((t: any) =>
      `- ${formatDateNaturally(t.date)} at ${formatTimeNaturally(t.time)} (${t.date} ${t.time})`
    ).join('\n');
    const lastSlot = session.timeslotsAvailable[session.timeslotsAvailable.length - 1];
    prompt += `\nAVAILABLE TIMESLOTS (these are ALL available slots — no others exist beyond ${formatDateNaturally(lastSlot.date)}):\n${slotLines}\n`;
    prompt += `When the customer mentions ANY time or date preference, call select_timeslot IMMEDIATELY with exactly what they said — do NOT ask clarifying questions about the date or day first. The tool will find the best match. Only ask for clarification if select_timeslot returns NO_MATCH. If they ask for a date/time not in this list (e.g. "what about March?"), explain politely that online availability only goes up to ${formatDateNaturally(lastSlot.date)} and offer the closest available slot. Do NOT invent slots.\n`;
    prompt += `If the customer asks to add another service at this point (e.g. "can you also do the brakes?", "add a full service too"), call select_service with that service name immediately — do NOT call select_timeslot yet.\n`;
    prompt += `If the customer asks a quick side question (e.g. "how long does it take?", "do you need the keys?", "will you text me?"), answer it briefly in one sentence, then immediately continue with the slot step in the same reply.\n`;
  }

  // ── Slot confirmation context — LLM handles all responses at NEED_SLOT_CONFIRM ──
  if (session.step === Step.NEED_SLOT_CONFIRM && session.pendingSlotDate && session.pendingSlotTime) {
    const pendDate = formatDateNaturally(session.pendingSlotDate);
    const pendTime = formatTimeNaturally(session.pendingSlotTime);
    prompt += `\nSLOT CONFIRMATION: You proposed ${pendDate} at ${pendTime} for the customer's booking.\n`;
    prompt += `YOUR ONLY JOB RIGHT NOW is to handle the slot confirmation. Do NOT ask about other services, do NOT offer upsell, do NOT ask "is there anything else".\n`;
    prompt += `- If they confirm (yes/yeah/yep/any positive, even with typos like "yepp", "yess", "ye", "sure", "fine", "that'll do"): call confirm_slot immediately.\n`;
    prompt += `- If they want a different time or day: call select_timeslot with their preference.\n`;
    prompt += `- If they ask a question: answer briefly in one sentence, then re-ask "Shall I book you in for ${pendDate} at ${pendTime}?"\n`;
    prompt += `- If they give contact info (phone number, email, or postcode) instead of saying yes — they are implicitly confirming. Call confirm_slot first, then call set_contact_info with what they gave.\n`;
    prompt += `Do NOT repeat the service summary or total price — just handle the slot confirmation naturally.\n`;
    // Also inject slot list so LLM can offer alternatives if needed
    if (session.timeslotsAvailable?.length) {
      const slotLines = session.timeslotsAvailable.map((t: any) =>
        `- ${formatDateNaturally(t.date)} at ${formatTimeNaturally(t.time)} (${t.date} ${t.time})`
      ).join('\n');
      const lastSlot = session.timeslotsAvailable[session.timeslotsAvailable.length - 1];
      prompt += `\nAVAILABLE TIMESLOTS (if they want alternatives):\n${slotLines}\n`;
    }
  }

  // ── Post-booking context — booking already completed, handle follow-ups naturally ──
  if (session.step === Step.CONFIRMED || session.step === Step.DONE) {
    const makeTitle = (session.vehicleMake || '').toLowerCase().split(' ').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const modelTitle = (session.vehicleModel || '').toLowerCase().split(' ').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const slotDesc = session.bookingDate
      ? `${formatDateNaturally(session.bookingDate)} at ${formatTimeNaturally(session.bookingTime)}`
      : 'their chosen slot';
    // Show all services + combined price
    const allServices = session.serviceSelectedNames?.length > 1
      ? session.serviceSelectedNames.join(' + ')
      : (session.serviceSelectedName || 'unknown');
    const priceNum = parseFloat(String(session.servicePrice));
    const additionalNum = parseFloat(String(session.additionalServicePrice || '0'));
    const totalPrice = (!isNaN(priceNum) && priceNum >= 1)
      ? `£${(priceNum + ((!isNaN(additionalNum) && additionalNum >= 1) ? additionalNum : 0)).toFixed(2).replace(/\.00$/, '')}`
      : 'POA';
    prompt += `\nBOOKING COMPLETE: The customer's booking is already confirmed and submitted.
- Services: ${allServices} for the ${makeTitle} ${modelTitle} (${session.vrn})
- Total price: ${totalPrice}
- Slot: ${slotDesc}
- This booking is DONE. Do NOT try to re-book, ask for contact details, ask for postcode/house number, or restart any part of the booking flow.
- You have NO tools available — just answer questions naturally using the info above.

YOUR ROLE NOW: You are a human-like customer service rep following up on WhatsApp. The customer might:
- Ask about price/cost/total → tell them: "${allServices} comes to ${totalPrice}"
- Ask a question about the booking → answer naturally using the info above
- Ask to add another service → explain honestly: "The booking is already submitted, but I can pass a note to the team to sort that when your car's in. Or if you'd prefer, you can call us on ${config.phoneNumber || 'the garage number'} and they'll add it to the system."
- Ask about schedules/appointments → you can only see THIS booking. Say: "I can see your ${allServices} for ${slotDesc}. For anything else, the team at the garage would be able to check for you."
- Ask a general question → answer if you know (opening hours, address, services offered), otherwise suggest calling the garage
- Say thanks/bye → respond warmly and naturally\n`;
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

  // Outbound context at NEED_SERVICE — only for outbound sessions before upsell has fired
  if (session.outboundServiceType && session.vrn &&
      session.step === Step.NEED_SERVICE && !session.outboundUpsellOffered) {
    const svcLabel = session.outboundServiceType === 'service' ? 'service' : 'MOT';
    prompt += `OUTBOUND CONTEXT: This customer replied to an outbound ${svcLabel} reminder`;
    if (session.outboundDueDate) prompt += ` (due ${session.outboundDueDate})`;
    prompt += `.\nCall confirm_vehicle then select_service('${svcLabel === 'service' ? 'Full Service' : svcLabel}') — do NOT ask generically what they need.\n\n`;
  }

  // Upsell follow-up — fires for ALL sessions (cold or outbound) after upsell was offered
  if (session.outboundUpsellOffered && session.step === Step.NEED_SERVICE) {
    const upsellSvcName = session.upsellServiceName || 'the service';
    const knownName = session.customerNameFirst ? ` Customer name is already known: ${session.customerNameFirst}.` : '';
    prompt += `UPSELL FOLLOW-UP: "${upsellSvcName}" is already confirmed in GarageHive. Timeslots are loaded.${knownName} Based on the customer's latest message:\n`;
    prompt += `- Named a specific service (or asked "how much for X?") → call select_service with that name IMMEDIATELY. Do NOT quote prices from memory — you must call select_service to confirm the service and get its real price.\n`;
    prompt += `- Asked about cost/price WITHOUT naming a specific service ("what would that cost?", "how much?", "how much would it be?", "what's the price?") → ask "Which service were you thinking — something like a full service, an oil change, or something else?" and wait. Do NOT quote any prices from memory.\n`;
    prompt += `- Customer says "both", "both of them", "let's do both", "yes add it", "the lot", "all of them", "yes both", "yeah both", "all of them" → scan the RECENT CONVERSATION (both customer and agent messages) for the most recently mentioned service name — e.g. if the customer asked "do you do brakes?" or the agent said "did you want a brake service?", the service is "brakes" — then call select_service with that name IMMEDIATELY. Do NOT ask for confirmation.\n`;
    prompt += `- Said YES / yeah but NO service name anywhere in recent conversation → ask "Which service would you like to add?" and wait\n`;
    prompt += `- Gave a date, time, or availability preference (any day name like "friday", "monday", time-of-day like "afternoon"/"morning", specific time like "11:30am", or words like "soonest", "asap", "earliest", "any time", "don't mind", "whenever") → call select_timeslot with that preference immediately. Do this EVEN IF the message also contains "yeah"/"yes"/"sure" — if you see a date or time, call select_timeslot.\n`;
    prompt += `- Declined only, no date given ("no thanks", "just the X", "nah") → reply "No problem! Do you have a date in mind?" and wait\n`;
    prompt += `CRITICAL: "${upsellSvcName}" is already booked. Do NOT call select_service('${upsellSvcName}') again. Do NOT ask for name or VRN. Never quote prices without calling select_service first.\n\n`;
  }

  // ── Service removal — honest response ────────────────────────────────────
  if (session.serviceSelectedName) {
    prompt += `SERVICE REMOVAL: ONLY if the customer explicitly says to remove, delete, cancel, or drop the "${session.serviceSelectedName}" booking (using words like "remove it", "cancel the booking", "forget it", "don't book that", "scrap it"): say "I'm afraid I can't remove it from the system at this point, but I'll make sure to leave a note for the team to double-check when you come in. Did you want to continue with the booking?"\n`;
    prompt += `Do NOT apply SERVICE REMOVAL for: questions about what other services are available, asking to add a different service, asking about pricing, or any other non-removal question.\n\n`;
  }

  // ── Branch selection (for multi-location garages) ────────────────────────
  const hasMultipleBranches = GARAGE_BRANCHES.length > 1;
  const branchNames = GARAGE_BRANCHES.map(b => b.name);
  const branchListStr = branchNames.join(' or ');
  if (hasMultipleBranches && session.step === Step.NEED_BRANCH && !session.selectedBranch) {
    prompt += `BRANCH SELECTION REQUIRED: We have ${branchNames.length} branches.\n`;
    prompt += `As your FIRST action, ask: "Which branch would you like to book with — ${branchListStr}?"\n`;
    prompt += `Wait for their response, then call select_branch with their choice.\n\n`;
  }
  if (session.selectedBranch) {
    prompt += `Branch: ${session.selectedBranch}\n`;
  }

  // ── Booking flow instructions ─────────────────────────────────────────────
  const bookingFlowStart = hasMultipleBranches && !session.selectedBranch
    ? `0. Ask which branch (${branchListStr}) → call select_branch\n1. `
    : `1. `;
  
  prompt += `BOOKING FLOW (follow STRICTLY in order — never skip or reorder steps):\n${bookingFlowStart}Get customer name + intent → call save_caller_name
2. Get vehicle registration → call lookup_vehicle
3. IMMEDIATELY call confirm_vehicle(confirmed=true) — do NOT wait for customer input, do NOT ask them to confirm, just call it silently
4. ONLY after confirm_vehicle succeeds → customer says what work is needed → call select_service
5. Offer timeslots from tool response → handled automatically, no tool call needed from you
6. Contact details collected automatically after timeslot
7. Booking confirmed ✅

CRITICAL TOOL ORDER RULES:
- NEVER call select_service before confirm_vehicle has been called and returned successfully — the services list does not exist yet
- NEVER call select_timeslot before select_service has been called and returned successfully
- If you are tempted to call select_service but confirm_vehicle has not been called yet, call confirm_vehicle(confirmed=true) first, then select_service
- Never call multiple booking tools in the same turn — one tool per response

YOUR CAPABILITIES — be honest about these:
- You can book new appointments (MOT, servicing, repairs) through GarageHive
- You can answer general questions using info in this prompt (opening hours, address, services offered, prices)
- That's it. You CANNOT check MOT due dates, look up existing bookings, check vehicle history, or access any external system beyond the booking engine. If a customer asks for something outside your capabilities, say so honestly and offer what you CAN do (book them in or take a message). Never say "hold on" or "let me check" for something you cannot do.

GENERAL RULES:
- Tools return instructions — follow them exactly, especially "Say: ..." and "Wait for ..." phrases
- NEVER answer questions about services/prices from your own knowledge — only use what tools return after confirm_vehicle has been called
- Keep responses short (1–2 sentences)
- Address customer by first name only
- Never invent booking details — only use what tools return
- If the customer asks a side question mid-booking (e.g. "how long does it take?", "what time do you open?", "is parking free?"), answer briefly in one sentence, then immediately continue with the current booking step — do NOT ignore the question and do NOT abandon the booking flow
- If you cannot proceed, offer to take a message for a callback
- If the customer says "quote", "how much", "what does it cost" or similar AFTER the vehicle is already confirmed, just tell them the price from the already-selected service in CURRENT STATE and continue the booking — do NOT call take_message, do NOT end the conversation
- Never say goodbye or end the chat unless the booking is fully confirmed AND all contact details have been collected
- If the current step is need_timeslot and the customer says "that's all", "nothing else", "just the MOT/service", "no thanks", "nope", or any short/negative reply — this means "no extras, proceed with booking". Do NOT say goodbye. Immediately ask: "Do you have a preferred date in mind, or shall I suggest the earliest available?"

RECOGNISING AFFIRMATIVE RESPONSES:
- Treat ALL of the following as "yes": yes, yeah, yep, yup, yh, ye, ya, sure, ok, okay, correct, right, perfect, great, fine, go ahead, do it, brill, brilliant, lovely, spot on, sounds good, that works, that's right, cheers
- NEVER ask for a registration again if the customer says yes/yh/ya/ye/yep/yup to a question about their vehicle — call confirm_vehicle(confirmed=true) instead
- If the customer has already confirmed their vehicle (CURRENT STATE shows Vehicle) and says any affirmative, proceed with the booking — do NOT restart the flow\n`;

  if ((config as any).messagingHumanHandoff === false) {
    const custom = ((config as any).messagingHandoffMessage || '').trim();
    if (custom) {
      prompt += `\nMESSAGING HANDOFF IS OFF: You cannot take messages, pass details to the team, or arrange callbacks — the take_message tool is unavailable. Any time you would normally take a message or offer a callback (including when a booking can't be completed, a vehicle or price can't be found, or the customer asks to speak to a person), do NOT — instead reply with this exact message: "${custom}". You can still answer from your knowledge and complete bookings through the diary.\n`;
    } else {
      const esc = [config.phoneNumber ? `phone ${config.phoneNumber}` : '', config.emailAddress ? `email ${config.emailAddress}` : ''].filter(Boolean).join(' or ');
      prompt += `\nHUMAN ESCALATION IS OFF: You cannot take messages, pass details to the team, or arrange callbacks — the take_message tool is unavailable. Any time you would normally take a message or offer a callback (including when a booking can't be completed, a vehicle or price can't be found, or the customer asks to speak to a person), do NOT offer to take details or call back. Instead tell the customer to contact the garage directly${esc ? ` on ${esc}` : ''}, as no one is available over chat. You can still answer from your knowledge and complete bookings through the diary.\n`;
    }
  }

  // Advisory upsell context — set when an outstanding health-check advisory was
  // offered during a reminder booking. Lets later turns handle acceptance coherently.
  if (session.advisoryText) {
    prompt += `\nADVISORY UPSELL: This customer was offered outstanding health-check advisories on their vehicle: ${session.advisoryText}. If they agree to any of them, briefly confirm and add it to the booking notes (via confirm_booking's notes) so the garage sorts it while the car's in. If they decline, drop it gracefully and don't offer again. Never invent advisories beyond the ones listed here.\n`;
  }

  return prompt;
}

