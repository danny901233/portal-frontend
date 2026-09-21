/**
 * Unified chat agent — one agent, four booking systems.
 *
 * Replaces the fork-per-diary pattern (chatAgentV2 + chatAgentTyresoft + chatAgentBookar +
 * chatAgentPoole, ~10,700 lines that drift apart silently) with one agent whose diary is a
 * configuration value. chatAgentV2 is the benchmark; everything diary-shaped lives behind
 * a ChatDiaryAdapter, verified by 118 booking journeys against the four test accounts.
 *
 * Nothing here imports or modifies a production chat agent, and nothing routes to this
 * file yet — chatAgentRouter is untouched.
 *
 * Three rules carried over from the voice merge, each learned by getting it wrong:
 *
 *   1. TOOLS ARE CAPABILITY-GATED. A tool the diary cannot honour is not offered, because
 *      the model offers whatever it can see. Bookar and Poole spent a whole session with
 *      reschedule declared and unreachable.
 *   2. NO PROMPT NAMES A TOOL THE DIARY LACKS. Telling a Tyresoft agent to check service
 *      history it does not have made it improvise "do you have a service book?".
 *   3. THE FLOW BELONGS TO THE DIARY. Leaving one diary's ordering in the shared prompt
 *      makes every other diary inherit it — a tyre request answered with "what type of
 *      work would you like to book in for?".
 */

import OpenAI from 'openai';
import { prisma } from '../db.js';
import { GarageHiveChatDiary } from './chatDiaries/garageHive.js';
import { TyresoftChatDiary } from './chatDiaries/tyresoft.js';
import { tyreStockFor } from './chatDiaries/tyreStock.js';
import { notifyMessaging } from './messagingNotifications.js';
import { notifyFlaggedConversation } from '../utils/push.js';
import { BookarChatDiary } from './chatDiaries/bookar.js';
import { PooleChatDiary } from './chatDiaries/poole.js';
import {
  type ChatDiaryAdapter, type DiaryService, type DiarySlot, type DiaryTyre, DiaryError,
} from './chatDiaries/types.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.UNIFIED_CHAT_MODEL || 'gpt-4.1-mini';
const MAX_TOOL_ITERATIONS = 8;

export interface UnifiedChatResponse {
  content: string;
  needsHumanAssistance?: boolean;
  /** Which diary served this turn, for the call/message record. */
  diary?: string;
}

/** Per-conversation working state. Deliberately small: anything the diary owns lives on
 *  the adapter, so this holds only what the conversation itself knows. */
interface UnifiedSession {
  registration?: string;
  customerName?: string;
  phone?: string;
  email?: string;
  postcode?: string;
  address?: string;
  mileage?: string;
  services: DiaryService[];
  chosenServiceKeys: string[];
  slots: DiarySlot[];
  tyreOptions: DiaryTyre[];
  bookingReference?: string;
  /** The slot they settled on, kept even when the booking then fails. */
  chosenSlotLabel?: string;
  messageTaken?: boolean;
  history: OpenAI.Chat.ChatCompletionMessageParam[];
}

const sessions = new Map<string, UnifiedSession>();
/** Adapters hold a booking session (Garage Hive) or a draft (Poole), so one instance per
 *  conversation — not per process, and never a module-level global. chatAgentV2 keeps its
 *  Garage Hive credentials in module `let`s reassigned per garage, which two garages
 *  messaging at once can interleave. */
const adapters = new Map<string, { garageId: string; adapter: ChatDiaryAdapter }>();

export function invalidateUnifiedSession(conversationId: string): void {
  sessions.delete(conversationId);
  adapters.delete(conversationId);
}

function blankSession(): UnifiedSession {
  return { services: [], chosenServiceKeys: [], slots: [], tyreOptions: [], history: [] };
}

// ── Choosing the diary ───────────────────────────────────────────────────────

interface GarageConfig {
  name: string;
  agentScript?: string | null;
  integrationProvider?: string | null;
  config: Record<string, any>;
  dataCollectionFields?: any[];
  customRules?: unknown;
  faqs?: unknown;
  greeting?: string | null;
  // Everything below was set in the portal and never reached the agent. A garage with hours,
  // an address and a phone number on file was answering "our hours may vary by location" and
  // asking a single-site customer which branch they meant.
  agentName?: string | null;
  branchName?: string | null;
  branchAddress?: string | null;
  phoneNumber?: string | null;
  emailAddress?: string | null;
  websiteUrl?: string | null;
  weeklyOpeningHours?: any;
  holidayClosures?: any;
  bankHolidayDates?: any;
  allowBookings?: boolean | null;
  bookingLeadTimeDays?: number | null;
  tonePreference?: string | null;
  messagingHumanHandoff?: boolean | null;
  messagingHandoffMessage?: string | null;
  enableDropOffBookings?: boolean | null;
  dropOffMessage?: string | null;
  dropOffExcludeServices?: any;
  serviceIntervalMonths?: number | null;
  serviceIntervalMiles?: number | null;
  advisoryUpsellsEnabled?: boolean | null;
  advisoryUpsellPrices?: boolean | null;
  agentType?: string | null;
  allowFastFitOnly?: boolean | null;
  businessType?: string | null;
  callerRecognitionEnabled?: boolean | null;
  enableSmsBookingLinks?: boolean | null;
  humanEscalation?: boolean | null;
  servicePairs?: any;
  transferNumber?: string | null;
}

export async function loadGarage(garageId: string): Promise<GarageConfig | null> {
  const rows: any[] = await prisma.$queryRawUnsafe(
    `SELECT g.name, a."agentScript" AS script, a."integrationProvider" AS prov,
            a."integrationProviderConfig" AS cfg, a."dataCollectionFields" AS fields,
            a."customRules" AS rules, a."faqs" AS faqs, a."greetingLine" AS greeting,
            a."agentName", a."branchName", a."branchAddress", a."phoneNumber",
            a."emailAddress", a."websiteUrl", a."weeklyOpeningHours", a."holidayClosures",
            a."bankHolidayDates", a."allowBookings", a."bookingLeadTimeDays",
            a."tonePreference", a."messagingHumanHandoff", a."messagingHandoffMessage",
            a."enableDropOffBookings", a."dropOffMessage", a."dropOffExcludeServices",
            a."serviceIntervalMonths", a."serviceIntervalMiles",
            a."advisoryUpsellsEnabled", a."advisoryUpsellPrices", a."agentType",
            a."allowFastFitOnly", a."businessType", a."callerRecognitionEnabled",
            a."enableSmsBookingLinks", a."humanEscalation", a."servicePairs",
            a."transferNumber"
     FROM "Garage" g JOIN "AgentConfiguration" a ON a."garageId" = g.id
     WHERE g.id = $1`, garageId);
  const row = rows[0];
  if (!row) return null;
  return {
    name: String(row.name || ''),
    agentScript: row.script,
    integrationProvider: row.prov,
    config: (row.cfg || {}) as Record<string, any>,
    dataCollectionFields: Array.isArray(row.fields) ? row.fields : [],
    customRules: row.rules,
    faqs: row.faqs,
    greeting: row.greeting,
    agentName: row.agentName,
    branchName: row.branchName,
    branchAddress: row.branchAddress,
    phoneNumber: row.phoneNumber,
    emailAddress: row.emailAddress,
    websiteUrl: row.websiteUrl,
    weeklyOpeningHours: row.weeklyOpeningHours,
    holidayClosures: row.holidayClosures,
    bankHolidayDates: row.bankHolidayDates,
    allowBookings: row.allowBookings,
    bookingLeadTimeDays: row.bookingLeadTimeDays,
    tonePreference: row.tonePreference,
    messagingHumanHandoff: row.messagingHumanHandoff,
    messagingHandoffMessage: row.messagingHandoffMessage,
    enableDropOffBookings: row.enableDropOffBookings,
    dropOffMessage: row.dropOffMessage,
    dropOffExcludeServices: row.dropOffExcludeServices,
    serviceIntervalMonths: row.serviceIntervalMonths,
    serviceIntervalMiles: row.serviceIntervalMiles,
    advisoryUpsellsEnabled: row.advisoryUpsellsEnabled,
    advisoryUpsellPrices: row.advisoryUpsellPrices,
    agentType: row.agentType,
    allowFastFitOnly: row.allowFastFitOnly,
    businessType: row.businessType,
    callerRecognitionEnabled: row.callerRecognitionEnabled,
    enableSmsBookingLinks: row.enableSmsBookingLinks,
    humanEscalation: row.humanEscalation,
    servicePairs: row.servicePairs,
    transferNumber: row.transferNumber,
  };
}

/**
 * Which booking system this garage uses.
 *
 * The signals are the ones chatAgentRouter already reads — agentScript first, then working
 * credentials — so routing behaviour is unchanged; only what sits behind it differs. A
 * garage carrying a diary's credentials while its provider still says "none" gets that
 * diary, which is how a Bookar garage once silently ran the Garage Hive agent.
 */
export function chooseDiary(garage: GarageConfig, tyreInventory: any[] = []): ChatDiaryAdapter {
  const script = String(garage.agentScript || '').toLowerCase();
  const provider = String(garage.integrationProvider || '').toLowerCase();
  const cfg = garage.config || {};

  const wantsTyresoft = script.includes('tyresoft') || provider === 'tyresoft' || cfg.tsApiKey;
  const wantsBookar = script.includes('bookar') || provider === 'bookar' || cfg.bookarClientId;
  const wantsPoole = script.includes('poole') || provider === 'poole'
    || (cfg.branchKey && cfg.tenant) || cfg.poole?.branchKey;

  // Without stock every tyre search matches nothing, so load the depot's rows unless a
  // caller has already supplied them.
  if (wantsTyresoft) {
    return new TyresoftChatDiary(cfg as any,
      tyreInventory.length ? tyreInventory : tyreStockFor(cfg.tsDepotId ?? cfg.depotId));
  }
  if (wantsBookar) return new BookarChatDiary(cfg);
  if (wantsPoole) {
    return new PooleChatDiary({
      branchKey: cfg.branchKey ?? cfg.poole?.branchKey,
      tenant: cfg.tenant ?? cfg.poole?.tenant,
    });
  }
  return new GarageHiveChatDiary({
    customerId: cfg.customerId ?? cfg.ghCustomerId,
    apiKey: cfg.apiKey ?? cfg.ghApiKey,
    locationId: String(cfg.locationId ?? cfg.ghLocationId ?? '23'),
  });
}

// ── Tools, gated on what the diary can actually do ───────────────────────────

type Tool = OpenAI.Chat.Completions.ChatCompletionTool;

/** A tool's name. ChatCompletionTool is a union and only the function variant carries one, so
 *  reading `.function.name` straight off it does not compile. */
function toolName(t: Tool): string {
  return (t as { function?: { name?: string } }).function?.name ?? '';
}

export function buildTools(adapter: ChatDiaryAdapter, garage?: GarageConfig): Tool[] {
  const c = adapter.capabilities;
  const fn = (name: string, description: string, properties: Record<string, any>,
              required: string[] = []): Tool => ({
    type: 'function',
    function: { name, description, parameters: { type: 'object', properties, required } },
  });

  let tools: Tool[] = [
    fn('save_customer_details', 'Record the customer\'s name, number and anything else they '
      + 'have given. Call it as soon as you have a detail, not at the end.', {
      name: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string' },
      postcode: { type: 'string' }, address: { type: 'string' }, mileage: { type: 'string' },
    }),
    fn('set_registration', 'Record the vehicle registration once the customer has given it.', {
      registration: { type: 'string' },
    }, ['registration']),
    fn('offer_services', 'Get what this garage can do for the vehicle, with prices. Needs the '
      + 'registration first. Quote only from what this returns.', {
      registration: { type: 'string' },
    }),
    fn('check_availability', 'Real appointment times for EVERY service they asked for. Pass '
      + 'all of the service ids together — a customer wanting two jobs keeps both.', {
      service_ids: { type: 'array', items: { type: 'string' } },
      from_date: { type: 'string', description: 'YYYY-MM-DD, optional' },
    }, ['service_ids']),
    fn('confirm_booking', 'Place the booking. Only after reading the whole thing back and '
      + 'getting a clear yes.', {
      slot: { type: 'string', description: 'the slot key exactly as check_availability gave it' },
      read_back: { type: 'boolean', description: 'true once you have read it back and they agreed' },
      notes: { type: 'string' },
    }, ['slot', 'read_back']),
    fn('take_message', 'Take a message for the team. The ONLY way anyone hears about this '
      + 'conversation — not calling it loses it.', {
      reason: { type: 'string', description: 'What they want, in one or two sentences.' },
      preferred_day: {
        type: 'string',
        description: 'The day or time they said would suit, on its own — "Tuesday", "Tuesday '
          + 'morning", "after the 15th". Pass it here as well as mentioning it in the reason: '
          + 'buried in a sentence, only a human reading the thread can find it.',
      },
    }, ['reason']),
  ];

  if (c.vehicleLookup) {
    tools.push(fn('lookup_vehicle', 'Look the vehicle up from the registration. Returns the '
      + 'make and model'
      + (c.tyreSales ? ', and the tyre sizes on record — read those back rather than asking '
        + 'the customer to read their sidewall.' : '.'), {}));
  }
  if (c.customerLookup) {
    tools.push(fn('find_customer', 'Find this customer from their phone number so you can '
      + 'greet them by name and see their vehicles.', { phone: { type: 'string' } }));
  }
  if (c.branches) {
    tools.push(fn('list_branches', 'The branches this garage has, when the customer needs to '
      + 'choose one.', {}));
  }
  if (c.tyreSales) {
    tools.push(fn('search_tyres', 'Search tyre stock by size. Ask which quality they want '
      + 'first — budget, mid-range or premium — because the tier decides what they are shown.', {
      size: { type: 'string', description: 'e.g. 235/60 R18' },
      position: { type: 'string', description: 'all four / front pair / rear pair / single' },
      quality: { type: 'string', enum: ['budget', 'mid-range', 'premium'] },
      brand: { type: 'string' },
    }, ['size', 'quality']));
    tools.push(fn('add_tyre', 'Put a tyre from the last search on the job.', {
      option_number: { type: 'integer', description: '1-based index into the last search' },
      quantity: { type: 'integer' },
    }, ['option_number']));
  }
  if (c.basket) {
    tools.push(fn('add_service_to_job', 'Put a service on the same job as the tyres — a '
      + 'customer can have tyres and an MOT on one visit.', {
      service_id: { type: 'string' },
    }, ['service_id']));
    tools.push(fn('view_job', 'Everything currently on the job, with a total.', {}));
  }
  if (c.retrieveBooking) {
    tools.push(fn('retrieve_booking', 'Look an existing booking up by its reference, so you '
      + 'are certain which one they mean before changing anything.', {
      reference: { type: 'string' },
    }, ['reference']));
  }
  if (c.reschedule) {
    tools.push(fn('reschedule_booking', 'Move an existing booking. Read back what you are '
      + 'about to change first.', {
      reference: { type: 'string' }, slot: { type: 'string' },
    }, ['reference', 'slot']));
  }
  if (c.cancel) {
    tools.push(fn('cancel_booking', 'Cancel an existing booking. Ask why first.', {
      reference: { type: 'string' }, reason: { type: 'string' },
    }, ['reference', 'reason']));
  }
  if (garage) {
    // A garage that has turned these off must not merely be ASKED not to use them. Withdrawing
    // the tool is the only version the model cannot talk itself past.
    if (garage.messagingHumanHandoff === false) {
      tools = tools.filter((t) => toolName(t) !== 'take_message');
    }
    if (!garage.callerRecognitionEnabled) {
      tools = tools.filter((t) => toolName(t) !== 'find_customer');
    }
  }
  return tools;
}

// ── Running one tool call ────────────────────────────────────────────────────

/**
 * Map whatever the model passed for a slot onto one we actually offered.
 *
 * Adapters take an opaque key ("2026-09-07|08:30") and reject anything else. The model mostly
 * passes it back verbatim, but sometimes hands over the label it read to the customer, or just
 * the date — and a hard rejection there costs the customer the booking over a formatting
 * detail. Only slots we offered can be matched, so this cannot invent a time.
 */
/**
 * Map whatever the model passed for a service onto one that was actually offered.
 *
 * Same failure as slot keys: the model mostly returns the id it was given, but sometimes hands
 * back the name it read to the customer ("full service 1200cc-1599cc") or a slug of its own
 * ("brake_check"). Matching on name recovers those; anything still unrecognised is reported
 * with the valid list rather than passed down to fail inside the diary.
 */
function resolveServiceKey(raw: string, services: DiaryService[]): string | null {
  const want = String(raw || '').trim();
  if (!want) return null;
  if (services.some((x) => x.key === want)) return want;
  const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const target = norm(want);
  return services.find((x) => norm(x.name) === target)?.key
    ?? services.find((x) => norm(x.name).startsWith(target) || target.startsWith(norm(x.name)))?.key
    ?? null;
}

function resolveSlotKey(raw: string, slots: DiarySlot[]): string {
  const want = String(raw || '').trim();
  if (!want) return want;
  const exact = slots.find((s) => s.key === want);
  if (exact) return exact.key;
  const lower = want.toLowerCase();
  const byLabel = slots.find((s) => s.label.toLowerCase() === lower);
  if (byLabel) return byLabel.key;
  // A date and a time in any order/format: match on both, then on the date alone taking the
  // earliest that day, which is what "the 7th" means when only one time was discussed.
  const date = /(\d{4}-\d{2}-\d{2})/.exec(want)?.[1];
  const time = /(\d{1,2}):(\d{2})/.exec(want);
  const hhmm = time ? `${time[1].padStart(2, '0')}:${time[2]}` : '';
  if (date && hhmm) {
    const both = slots.find((s) => s.key.startsWith(date) && s.key.endsWith(hhmm));
    if (both) return both.key;
  }
  if (date) {
    const sameDay = slots.filter((s) => s.key.startsWith(date));
    if (sameDay.length) return sameDay[0].key;
  }
  return want;
}

function slotLines(slots: DiarySlot[]): string {
  return slots.slice(0, 8).map((s) => `  ${s.key} -> ${s.label}`).join('\n');
}

export async function runTool(
  name: string, args: Record<string, any>, adapter: ChatDiaryAdapter, s: UnifiedSession,
): Promise<string> {
  const fail = (why: string) => {
    // A DiaryError is caught and returned as text, so without this the reason a booking
    // failed never reaches the log and the only evidence is the customer being asked the
    // same question again.
    console.warn(`[UNIFIED_CHAT] ${name} failed: ${why}`);
    // Ask for a preferred day ONLY if we do not already have one. Asking unconditionally is
    // what turned every failed booking into a loop: the customer answers, the next attempt
    // fails the same way, and the same instruction comes back and asks again.
    const known = s.chosenSlotLabel;
    const step = known
      ? `Call take_message NOW with everything you have, including their preferred time of `
        + `${known}. Do not ask them for a day — they have already given you one.`
      : `Ask which day would suit, then call take_message with everything you have and their `
        + `answer in preferred_day.`;
    return `STATUS: PROBLEM\n${why}\nDo NOT tell the customer anything went wrong — they cannot `
      + `see it. ${step} Then say the team will confirm. Never say booked, reserved or all set.`;
  };

  try {
    switch (name) {
      case 'save_customer_details': {
        for (const k of ['name', 'phone', 'email', 'postcode', 'address', 'mileage'] as const) {
          if (args[k]) (s as any)[k === 'name' ? 'customerName' : k] = String(args[k]);
        }
        return 'STATUS: OK — noted silently. Do not read their own details back to them.';
      }
      case 'set_registration': {
        s.registration = String(args.registration || '').toUpperCase().replace(/\s+/g, '');
        // Tell the ADAPTER, not just the session. Poole and Tyresoft hold the vehicle in their
        // own state and only fill it here; without this their confirm goes up with an empty
        // registration and comes back "'Registration' must not be empty" / "No VRM has been
        // set" — after the customer has given every detail. Too important to leave to whether
        // the model chooses to call the optional lookup tool.
        let vehicle = null;
        if (adapter.capabilities.vehicleLookup) {
          try {
            vehicle = await adapter.lookupVehicle!(s.registration);
          } catch {
            // A lookup that fails is not a booking that fails: the reg is still good.
          }
        }
        const seen = vehicle?.description ? `\nVEHICLE: ${vehicle.description}` : '';
        // Reference only. Reading the size back is right when they want tyres and absurd when
        // they want an MOT — this asked "are your tyres 235/60R18?" before an MOT booking.
        const sizes = vehicle?.tyreSizes?.length
          ? `\nTYRE_SIZES_ON_RECORD (only if tyres come up — do not raise tyres yourself): `
            + `${vehicle.tyreSizes.join(', ')}. If they do want tyres, read the first back and `
            + 'ask if it is right rather than asking them to read their sidewall.' : '';
        return `STATUS: OK — registration ${s.registration}. Do not ask for it again.`
          + `${seen}${sizes}`;
      }
      case 'lookup_vehicle': {
        if (!s.registration) return 'STATUS: NO_REG — get the registration first.';
        const v = await adapter.lookupVehicle!(s.registration);
        if (!v) return 'STATUS: NOT_FOUND — no vehicle on that registration. Check it once, then carry on.';
        const sizes = v.tyreSizes?.length
          ? `\nTYRE_SIZES_ON_RECORD: ${v.tyreSizes.join(', ')} — read the first one back and ask `
            + 'if it is right. Do NOT ask them to read their sidewall.' : '';
        return `STATUS: OK\nVEHICLE: ${v.description || v.registration}${sizes}`;
      }
      case 'find_customer': {
        const cu = await adapter.findCustomerByPhone!(String(args.phone || s.phone || ''));
        if (!cu) return 'STATUS: NOT_FOUND — treat them as a new customer, and do not mention having looked.';
        if (cu.name && !s.customerName) s.customerName = cu.name;
        return `STATUS: OK\nCUSTOMER: ${cu.name || 'on file'}`;
      }
      case 'list_branches': {
        const b = await adapter.branches!();
        return `STATUS: OK\n${b.map((x) => `  ${x.key} — ${x.name}`).join('\n')}`;
      }
      case 'offer_services': {
        const reg = String(args.registration || s.registration || '');
        if (!reg) return 'STATUS: NO_REG — get the registration first.';
        s.registration = reg.toUpperCase().replace(/\s+/g, '');
        s.services = await adapter.offerServices(s.registration);
        if (!s.services.length) {
          return 'STATUS: NONE — the diary returned no services for this vehicle. Take a message.';
        }
        const list = s.services.map((x) => `  ${x.key} — ${x.name}`
          + (x.price !== undefined ? ` — £${x.price.toFixed(2)}` : ' — price not published')).join('\n');
        return `STATUS: OK\n${list}\nQuote EXACTLY these figures; never round, estimate or add VAT. `
          + 'A service with no price is one the garage chose not to publish — say the team will confirm it.';
      }
      case 'check_availability': {
        const ids = (args.service_ids || []).map(String).filter(Boolean);
        // What the model actually asked for, against what it was offered. "No availability"
        // and "at least one service must be chosen" both look like diary faults from the
        // outside and are usually neither.
        const resolved: { raw: string; key: string | null }[] =
          ids.map((k: string) => ({ raw: k, key: resolveServiceKey(k, s.services) }));
        const unknown = resolved.filter((r) => !r.key).map((r) => r.raw);
        if (unknown.length && s.services.length) {
          return `STATUS: NO_SUCH_SERVICE — ${unknown.join(', ')} is not one of this garage's `
            + `services. Use one of these ids exactly:\n`
            + s.services.map((x) => `  ${x.key} — ${x.name}`).join('\n');
        }
        if (s.services.length) ids.splice(0, ids.length, ...resolved.map((r) => r.key!));
        // A date in the past returns nothing and reads as "we have no availability". The model
        // does not reliably know what year it is, so anything before today is dropped rather
        // than sent — this was most of the no-availability failures, and none of them real.
        const today = new Date().toISOString().slice(0, 10);
        const from = args.from_date && String(args.from_date) >= today
          ? String(args.from_date) : undefined;
        console.warn(`[UNIFIED_CHAT] check_availability ids=${JSON.stringify(ids)} `
          + `from=${args.from_date || '-'}->${from || '-'} offered=${s.services.length}`);
        s.chosenServiceKeys = ids;
        s.slots = await adapter.offerSlots(ids, { fromDate: from });
        if (!s.slots.length && from) {
          // Nothing on the day they asked for is not the same as nothing at all. Ask again
          // without the date before falling back to a message — otherwise a customer who
          // wanted Sunday gets told to wait for a call back while Monday sits empty.
          s.slots = await adapter.offerSlots(ids);
          if (s.slots.length) {
            return `STATUS: NOT_THAT_DAY — nothing free then, but there is later. Say that day `
              + `is not available and offer the nearest of these:\n${slotLines(s.slots)}`;
          }
        }
        if (!s.slots.length) return fail('The diary returned no availability.');
        return `STATUS: OK\nSLOTS: ${s.slots.length}\n${slotLines(s.slots)}\n`
          + 'Ask when suits them rather than reading this list out, then offer one or two near it.';
      }
      case 'search_tyres': {
        const quality = String(args.quality || '').trim();
        if (!quality) {
          return 'STATUS: NEED_QUALITY — the tier decides what they are shown, so ask first: '
            + 'budget, mid-range or premium? If they do not mind, say what is on the car now.';
        }
        s.tyreOptions = await adapter.searchTyres!(String(args.size || ''), {
          position: args.position, quality, brand: args.brand,
        });
        if (!s.tyreOptions.length) {
          return 'STATUS: NO_STOCK — nothing in that size. Say so plainly and offer a callback. '
            + 'Never substitute a different size as though it were what they asked for.';
        }
        const lines = s.tyreOptions.map((t, i) =>
          `  [${i + 1}] ${t.brand} ${t.title} — £${t.price.toFixed(2)} each | ${t.tier}`
          + (t.leadTimeDays ? ` (in ${t.leadTimeDays} day(s))` : '')).join('\n');
        const asked = s.tyreOptions.some((t) => t.tier === quality)
          ? '' : `\nTIER_NOTE: nothing in ${quality} in this size — say that plainly and do NOT `
            + `describe any of these as ${quality}.`;
        return `STATUS: OK\n${lines}${asked}\nOffer two or three, cheapest first.`;
      }
      case 'add_tyre': {
        const i = Number(args.option_number) - 1;
        const t = s.tyreOptions[i];
        if (!t) return 'STATUS: ERROR — no such option. Search again.';
        const line = await adapter.addTyre!(t, Number(args.quantity) || 0);
        return `STATUS: OK — ${line.quantity} x ${line.description} at £${line.unitPrice.toFixed(2)} each. `
          + 'Ask if they need anything else on the same visit.';
      }
      case 'add_service_to_job': {
        const key = resolveServiceKey(String(args.service_id), s.services);
        if (!key && s.services.length) {
          return `STATUS: NO_SUCH_SERVICE — ${args.service_id} is not one of this garage's `
            + `services. Use one of these ids exactly:\n`
            + s.services.map((x) => `  ${x.key} — ${x.name}`).join('\n');
        }
        const line = await adapter.addServiceLine!(key || String(args.service_id));
        return `STATUS: OK — ${line.description} added to the same job.`;
      }
      case 'view_job': {
        const lines = adapter.basketLines!();
        if (!lines.length) return 'STATUS: EMPTY — nothing on the job yet.';
        const total = lines.reduce((a, l) => a + l.quantity * l.unitPrice, 0);
        return `STATUS: OK\n${lines.map((l) => `  ${l.quantity} x ${l.description} — `
          + `£${(l.quantity * l.unitPrice).toFixed(2)}`).join('\n')}\nTOTAL: £${total.toFixed(2)}`;
      }
      case 'confirm_booking': {
        // A hard stop, not advice. The prompt already says the booking is made; the model
        // still re-confirmed on "yes, go ahead" and booked the same MOT twice (TS-6099 and
        // TS-6100, same slot). A double booking costs the garage a slot and the customer
        // their trust, so it cannot rest on the model reading a note.
        if (s.bookingReference) {
          return `STATUS: ALREADY_BOOKED — this is already booked, reference `
            + `${s.bookingReference}. Do not book it again. Tell them it is confirmed, and if `
            + `they want a change, move or cancel that booking instead.`;
        }
        if (!args.read_back) {
          return 'STATUS: READ_BACK_FIRST — read the whole thing back in one natural sentence: '
            + 'their name, the work, and the full date with the weekday. Get a clear yes, then '
            + 'call this again with read_back true.';
        }
        // Everything the diary will REJECT the booking for, checked before we attempt it.
        // Each of these was found as a live 400 whose only symptom was the customer being
        // asked their name again: a diary refusing a booking cannot tell the agent what it
        // wanted, so the agent has to know first.
        const missing: string[] = [];
        if (!s.customerName) missing.push('their name');
        if (!s.phone) missing.push('a phone number');
        if (!s.registration) missing.push('the registration');
        if (adapter.capabilities.needsEmail && !s.email) missing.push('an email address');
        if (adapter.capabilities.needsAddress && !s.address) missing.push('their house number');
        if (missing.length) {
          return `STATUS: NEED_DETAILS — this diary will not accept the booking without `
            + `${missing.join(' and ')}. Ask for what is missing in one short question, save `
            + `it, then call this again. Do not say anything is booked yet.`;
        }
        const slotKey = resolveSlotKey(String(args.slot), s.slots);
        // Remember it BEFORE the attempt: if the confirm fails, this is what goes to the team,
        // and it is the reason we no longer have to ask them for a day all over again.
        s.chosenSlotLabel = s.slots.find((x) => x.key === slotKey)?.label || slotKey;
        const b = await adapter.confirm(slotKey, {
          // The precondition block above returns NEED_DETAILS unless both are present; the
          // compiler cannot see that through the optional session fields.
          name: s.customerName ?? '', phone: s.phone ?? '', email: s.email,
          address: s.address, postcode: s.postcode, mileage: s.mileage,
          notes: String(args.notes || ''),
        });
        s.bookingReference = b.reference;
        // The one line that says a booking is real. Without it "all booked" in the transcript
        // is just the model's word for it.
        console.log(`[UNIFIED_CHAT] BOOKED ${b.reference} ${b.whenIso} — ${b.serviceName || ''}`);
        return `STATUS: OK — booked, reference ${b.reference}. Only now tell them it is booked.`;
      }
      case 'retrieve_booking': {
        const b = await adapter.retrieveBooking!(String(args.reference));
        return b ? `STATUS: OK\n${b.serviceName || 'work'} — ${b.whenIso} (${b.reference})`
          : 'STATUS: NOT_FOUND — check the reference with them once, then take a message.';
      }
      case 'reschedule_booking': {
        const b = await adapter.reschedule!(String(args.reference), String(args.slot));
        return `STATUS: OK — moved to ${b.whenIso}. Read the new day and time back.`;
      }
      case 'cancel_booking': {
        if (!String(args.reason || '').trim()) {
          return 'STATUS: NEED_REASON — ask briefly why, then call this again.';
        }
        await adapter.cancel!(String(args.reference), String(args.reason));
        return 'STATUS: OK — cancelled. Confirm briefly and ask if they would like to rebook.';
      }
      case 'take_message': {
        s.messageTaken = true;
        const convId = (args.__conversationId as string) || '';
        // Write down what the message actually SAYS. This used to set a flag and nothing else,
        // so when the diary had no slots the agent asked which day would suit, was told, and
        // threw the answer away — the garage got a conversation marked "needs attention" and
        // had to read the thread to find the date the customer had already given.
        const note = {
          messageTaken: true,
          messageReason: String(args.reason || '').slice(0, 2000),
          preferredDay: String(args.preferred_day || '') || undefined,
          customerName: s.customerName, phone: s.phone, registration: s.registration,
          services: s.services.filter((x) => s.chosenServiceKeys.includes(x.key))
            .map((x) => x.name).filter(Boolean),
          takenAt: new Date().toISOString(),
        };
        await prisma.$executeRawUnsafe(
          `UPDATE "ChatConversation" SET "needsAttention" = true, `
          + `"sessionState" = COALESCE("sessionState", '{}'::jsonb) || $2::jsonb WHERE id = $1`,
          convId, JSON.stringify(note),
        ).catch((e) => console.error('[UNIFIED_CHAT] could not record the message:', e?.message));
        // A message nobody is told about is a lost lead. Guarded so a scenario run does not
        // send a push per conversation, exactly as the benchmark guards it.
        if (process.env.CHAT_SCENARIO_RUN !== '1' && convId) {
          void notifyFlaggedConversation(convId);
          void notifyMessaging({ conversationId: convId, event: 'escalated' });
        }
        return 'STATUS: OK — passed to the team, with their preferred day if they gave one. Say '
          + 'that only now, and if you have no number for them, do not promise a call back — '
          + 'offer that they can message again.';
      }
      default:
        return `STATUS: ERROR — no such tool ${name}.`;
    }
  } catch (e: any) {
    if (e instanceof DiaryError) return fail(e.message);
    throw e;
  }
}

// ── The prompt ───────────────────────────────────────────────────────────────

/** Shared behaviour, true whatever the diary. Anything diary-shaped comes from the
 *  adapter, so no diary inherits another's flow. */
/** The garage's own details, opening hours and switches, written for the prompt.
 *
 *  All of this was configured in the portal and none of it reached the agent, so a customer
 *  asking "what time do you open on Saturday?" got a deflection from a garage whose hours
 *  were on file. Anything not set is simply left out — an absent line is the agent saying it
 *  does not know, which is correct; an invented one is not. */
function garageFacts(g: GarageConfig): string {
  const lines: string[] = [];
  const named = g.branchName || g.name;
  if (named) lines.push(`This garage is ${named}.`);
  if (g.branchAddress) lines.push(`Address: ${g.branchAddress}. It has ONE location — never `
    + 'ask the customer which branch they mean.');
  if (g.phoneNumber) lines.push(`Phone: ${g.phoneNumber}.`);
  if (g.emailAddress) lines.push(`Email: ${g.emailAddress}.`);
  if (g.websiteUrl) lines.push(`Website: ${g.websiteUrl}.`);

  const wh = g.weeklyOpeningHours as Record<string, any> | null;
  if (wh && typeof wh === 'object') {
    const order = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    const days = order.filter((d) => wh[d]).map((d) => {
      const v = wh[d];
      const label = d[0].toUpperCase() + d.slice(1);
      return v.closed || !v.open ? `${label}: closed` : `${label}: ${v.open}–${v.close}`;
    });
    if (days.length) {
      lines.push(`OPENING HOURS — answer from these exactly and never invent one:\n  `
        + days.join('\n  '));
    }
  }
  const closures = Array.isArray(g.holidayClosures) ? g.holidayClosures
    : Array.isArray(g.bankHolidayDates) ? g.bankHolidayDates : [];
  if (closures.length) {
    lines.push(`CLOSED ON: ${closures.map(String).join(', ')}. Do not offer these days.`);
  }
  if (g.allowBookings === false) {
    lines.push('THIS GARAGE DOES NOT TAKE BOOKINGS THROUGH YOU. Do not offer or make one — '
      + 'answer what you can and take a message.');
  }
  if (g.enableDropOffBookings && g.dropOffMessage) {
    const excl = Array.isArray(g.dropOffExcludeServices) && g.dropOffExcludeServices.length
      ? ` This does NOT apply to: ${g.dropOffExcludeServices.map(String).join(', ')}.` : '';
    lines.push(`DROP-OFF: ${g.dropOffMessage}${excl}`);
  }
  if (g.messagingHumanHandoff === false) {
    lines.push('You CANNOT pass messages to the team from here. Do not offer to, and do not '
      + 'say you have. If they need a person, point them at the garage\'s phone number or '
      + 'email above.'
      + (g.messagingHandoffMessage ? ` Use this wording: "${g.messagingHandoffMessage}"` : ''));
  } else if (g.messagingHandoffMessage) {
    lines.push(`When handing over to the team, say: "${g.messagingHandoffMessage}"`);
  }
  if (g.tonePreference && g.tonePreference !== 'standard') {
    lines.push(`Tone: ${g.tonePreference}. Keep it that way throughout, not just in the greeting.`);
  }
  if (g.businessType) lines.push(`This business is a ${g.businessType}.`);

  // Booking behaviour the garage set and the agent was ignoring.
  const lead = Number(g.bookingLeadTimeDays);
  if (Number.isFinite(lead) && lead > 0) {
    lines.push(`EARLIEST BOOKING: ${lead} day${lead === 1 ? '' : 's'} from today. Do not offer `
      + 'anything sooner, however much they want it — say the earliest you can do and offer it.');
  }
  if (g.allowFastFitOnly) {
    lines.push('THIS GARAGE ONLY TAKES FAST-FIT WORK — tyres, exhausts, batteries, brakes and '
      + 'the like. Anything bigger is a message for the team, not a booking.');
  }
  const pairs = Array.isArray(g.servicePairs) ? g.servicePairs : [];
  if (pairs.length) {
    const shown = pairs.map((x: any) => typeof x === 'string' ? x
      : [x?.service, x?.pairsWith || x?.with].filter(Boolean).join(' + ')).filter(Boolean);
    if (shown.length) {
      lines.push(`OFTEN BOOKED TOGETHER: ${shown.join('; ')}. Offer the pair ONCE if it fits `
        + 'what they came for. If they say no, drop it.');
    }
  }
  if (g.advisoryUpsellsEnabled) {
    lines.push('If the vehicle has outstanding advisories, mention them once when booking'
      + (g.advisoryUpsellPrices === false
        ? ', without quoting a price — say the team will confirm the cost.'
        : ', with the price if a tool gave you one.')
      + ' Mention them once. A customer who says no has answered.');
  } else {
    lines.push('Do NOT raise advisory work or previous recommendations — this garage has that '
      + 'switched off. Book what they asked for.');
  }

  // How they reach a person, and what the agent may promise.
  if (g.humanEscalation === false) {
    lines.push('Do NOT offer to put them through to anyone or promise a call back.');
  }
  if (g.transferNumber) {
    lines.push(`If they need to speak to someone, the number is ${g.transferNumber}.`);
  }
  if (g.enableSmsBookingLinks === false) {
    lines.push('Do not offer to text them a booking link — this garage has that turned off.');
  }
  if (String(g.agentType || 'assist').toLowerCase() === 'assist' && !g.allowBookings) {
    lines.push('You take enquiries and messages here rather than making bookings yourself.');
  }

  // What this garage wants written down for every job.
  const fields = (g.dataCollectionFields || []).map((f: any) =>
    typeof f === 'string' ? f : (f?.label || f?.name || f?.field)).filter(Boolean);
  if (fields.length) {
    lines.push(`THIS GARAGE ALSO WANTS: ${fields.join(', ')}. Ask for these as the conversation `
      + 'goes, one at a time, not as a list — and never ask twice for the same one.');
  }

  const months = Number(g.serviceIntervalMonths) || 12;
  const miles = Number(g.serviceIntervalMiles) || 10000;
  lines.push(`SERVICE INTERVAL: roughly every ${miles.toLocaleString('en-GB')} miles or `
    + `${months} months, whichever comes first. Say "roughly" — it varies by vehicle, so never `
    + 'state it as this vehicle\'s exact schedule.');

  return lines.length ? `ABOUT THIS GARAGE:\n${lines.join('\n')}` : '';
}

function sharedCore(garage: GarageConfig, adapter: ChatDiaryAdapter): string {
  const c = adapter.capabilities;
  const parts: string[] = [
    `You are ${garage.agentName || 'the receptionist'} for `
    + `${garage.branchName || garage.name}, answering a customer's message.`,
    '',
    ...(garage.greeting ? [`Open the FIRST message of a conversation with the garage's own `
      + `greeting: "${String(garage.greeting).trim()}". Do not repeat it after that.`, ''] : []),
    garageFacts(garage),
    '',
    'HOW TO WRITE: short, warm and plain, the way a good receptionist types. One question at '
    + 'a time. No lists of questions, no bullet points at the customer, no repeating their own '
    + 'details back to them as a summary.',
    '',
    'PRICES AND TIMES ARE NEVER YOURS TO GUESS. Do not give a price, a range, a "typical" or a '
    + '"usually around" unless a tool returned it in THIS conversation for THIS vehicle. The '
    + 'same goes for how long a job takes. If you do not have it, say the team will confirm.',
    '',
    'THE SAME GOES FOR ANYTHING ABOUT THE GARAGE. Parking, courtesy cars, waiting rooms, '
    + 'collection, card payment, how many bays — say only what is written below or in the '
    + 'garage information. Asked something that is not there, say you are not sure and offer '
    + 'to check. "There is parking on site" invented to be helpful is the customer arriving '
    + 'to nowhere to park.',
    '',
    '"SOONEST", "EARLIEST" AND "ASAP" ARE ANSWERS. They have told you which slot they want: '
    + 'the first one the diary returned. Take it and read it back for confirmation — do not '
    + 'list the days again and ask them to choose, which is asking a question they have just '
    + 'answered.',
    '',
    'TAKE A MESSAGE IS A FALLBACK, NOT AN ALTERNATIVE. If they want work done, try to book it '
    + 'first. take_message is the ONLY way anyone hears about this conversation — not calling '
    + 'it loses them. But never say you have passed something on until it has returned OK.',
  ];
  if (c.needsAddress) {
    parts.push('', 'Once they have chosen a time, ask for their house number and postcode '
      + 'together, in one question, and only once. This diary rejects a booking with no house '
      + 'number. A bare number like "55" is the house number, not a postcode.');
  } else {
    parts.push('', 'This garage does NOT need an address. Do not ask for a postcode or house '
      + 'number; if they offer one, note it and move on.');
  }
  if (c.needsEmail) {
    parts.push('', 'This diary will NOT accept a booking without an email address. Ask for one '
      + 'alongside their name and number — before you try to confirm, not after it has failed.');
  }
  if (!c.serviceHistory) {
    parts.push('', 'You cannot see what this vehicle last had done. If they do not know which '
      + 'service they need, say so plainly and ask what it last had — do not imply you have '
      + 'looked at records.');
  }
  const rules = typeof garage.customRules === 'string' ? garage.customRules
    : Array.isArray(garage.customRules) ? garage.customRules.map(String).join('\n') : '';
  if (rules.trim()) {
    parts.push('', 'GARAGE-SPECIFIC RULES — follow these; where they conflict with the general '
      + `guidance above, these win:\n${rules.trim()}`);
  }
  return parts.join('\n');
}

/**
 * What this conversation already holds, stated plainly, rebuilt every turn.
 *
 * Without it the model starts each turn blind: it records a detail through a tool and then
 * has no way of knowing it did, so it asks again. Across 120 simulated conversations that
 * one gap caused nearly every failure — the registration asked for after it was given, the
 * postcode confirmed four times, a booking confirmed by the customer and asked about
 * again until the conversation ran out of turns. Telling it not to re-ask does not work.
 * Telling it what it has does.
 */
function knownSoFar(s: UnifiedSession, adapter: ChatDiaryAdapter): string {
  const have: string[] = [];
  if (s.customerName) have.push(`their name (${s.customerName})`);
  if (s.phone) have.push(`their number (${s.phone})`);
  if (s.email) have.push(`their email (${s.email})`);
  if (s.registration) have.push(`the registration (${s.registration})`);
  if (s.postcode) have.push(`their postcode (${s.postcode})`);
  if (s.address) have.push(`their address (${s.address})`);
  if (s.mileage) have.push(`the mileage (${s.mileage})`);

  const lines: string[] = [];
  if (have.length) {
    lines.push(`YOU ALREADY HAVE ${have.join(', ')}. Do NOT ask for any of these again, and `
      + 'do not ask them to confirm something they have already confirmed. If they correct '
      + 'one, take the correction and move on.');
  }
  if (s.messageTaken) {
    // The message is already with the team. Saying so a second time is fine; saying it in the
    // same words every turn is what made the callback conversations read as an agent that had
    // done nothing. Give it something else to say.
    lines.push('YOU HAVE ALREADY PASSED A MESSAGE TO THE TEAM. Do not call take_message again '
      + 'for the same request and do not keep repeating that you have passed it on. If they ask '
      + 'again, say once that it is logged and when they can expect a reply, then either help '
      + 'with something you CAN do here or leave it there. Never re-word the same promise.');
  }
  if (s.bookingReference) {
    lines.push(`THE BOOKING IS MADE (${s.bookingReference}). Do not book it again or ask for `
      + 'the details a second time; if they want a change, move or cancel that booking.');
  }
  if (s.chosenServiceKeys.length) {
    const names = s.services
      .filter((x) => s.chosenServiceKeys.includes(x.key))
      .map((x) => x.name).filter(Boolean);
    if (names.length) {
      lines.push(`THE JOB SO FAR: ${names.join(' and ')}. Keep every one of these — if they `
        + 'add something, add it alongside rather than replacing what is already there.');
    }
  }
  if (adapter.capabilities.basket && adapter.basketLines) {
    const b = adapter.basketLines();
    if (b.length) {
      lines.push(`ON THE JOB: ${b.map((l) => `${l.quantity} x ${l.description}`).join(', ')}.`);
    }
  }
  if (s.slots.length) {
    lines.push(`TIMES YOU HAVE ALREADY OFFERED: ${s.slots.slice(0, 6).map((x) => x.label).join('; ')}. `
      + 'Do not contradict these — if you said a day was available, it is.');
  }
  if (s.bookingReference) {
    lines.push(`ALREADY BOOKED — reference ${s.bookingReference}. It is done. Do NOT book it `
      + 'again, do not ask them to confirm it again, and do not offer more times for it.');
  }
  if (s.messageTaken) {
    lines.push('A MESSAGE HAS ALREADY BEEN PASSED TO THE TEAM for this conversation. Do not '
      + 'take another for the same thing, and do not keep promising it.');
  }
  return lines.length ? `WHAT YOU ALREADY KNOW:\n${lines.map((l) => `- ${l}`).join('\n')}` : '';
}

export function buildSystemPrompt(
  garage: GarageConfig, adapter: ChatDiaryAdapter, session?: UnifiedSession,
): string {
  const known = session ? knownSoFar(session, adapter) : '';
  // The agent was never told the date, so it guessed the year and asked the diary for
  // availability in 2024. Every one of those came back empty and read as a garage with no
  // free slots.
  const now = new Date();
  const today = `TODAY IS ${now.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} (${now.toISOString().slice(0, 10)}). `
    + 'Every date you use must be today or later. Work out "tomorrow", "next Tuesday" and so on '
    + 'from that date, and never guess a year.';
  return [
    today,
    '',
    sharedCore(garage, adapter),
    '',
    adapter.flowPrompt(),
    '',
    adapter.promptFragment(),
    ...(known ? ['', known] : []),
  ].join('\n');
}

// ── Entry point ──────────────────────────────────────────────────────────────

export async function getUnifiedChatResponse(
  garageId: string,
  message: string,
  conversationId: string,
  seedContact?: { phone?: string; name?: string },
): Promise<UnifiedChatResponse> {
  const garage = await loadGarage(garageId);
  if (!garage) return { content: 'Sorry, I could not find that garage.' };

  // One adapter per conversation. Rebuilt if the garage changed diary mid-conversation,
  // which a cached session would otherwise hide until the cache cleared.
  let entry = adapters.get(conversationId);
  if (!entry || entry.garageId !== garageId) {
    entry = { garageId, adapter: chooseDiary(garage) };
    adapters.set(conversationId, entry);
  }
  const adapter = entry.adapter;

  const session = sessions.get(conversationId) || blankSession();
  sessions.set(conversationId, session);
  if (seedContact?.phone && !session.phone) session.phone = seedContact.phone;
  if (seedContact?.name && !session.customerName) session.customerName = seedContact.name;

  const tools = buildTools(adapter, garage);
  if (process.env.UNIFIED_CHAT_DEBUG === '1') {
    const known = buildSystemPrompt(garage, adapter, session).split('WHAT YOU ALREADY KNOW:')[1];
    console.log(`[UNIFIED_CHAT_DEBUG] known-block: ${known ? known.trim().slice(0, 200) : 'EMPTY'}`);
  }
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: buildSystemPrompt(garage, adapter, session) },
    ...session.history,
    { role: 'user', content: message },
  ];

  let iterations = 0;
  let response = await openai.chat.completions.create({
    model: MODEL, messages, tools, tool_choice: 'auto', parallel_tool_calls: false,
  });

  while (response.choices[0]?.finish_reason === 'tool_calls' && iterations < MAX_TOOL_ITERATIONS) {
    iterations += 1;
    const call = response.choices[0].message;
    messages.push(call);
    for (const tc of call.tool_calls || []) {
      let args: Record<string, any> = {};
      try {
        args = JSON.parse((tc as any).function.arguments || '{}');
      } catch { /* a malformed argument blob is the model's problem to recover from */ }
      args.__conversationId = conversationId;
      let result: string;
      try {
        result = await runTool((tc as any).function.name, args, adapter, session);
      } catch (e: any) {
        console.error('[UNIFIED_CHAT] tool threw:', (tc as any).function.name, e?.message || e);
        result = 'STATUS: PROBLEM — that step did not work. Ask which day would suit and take '
          + 'a message; do not tell the customer anything went wrong.';
      }
      messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
    }
    response = await openai.chat.completions.create({
      model: MODEL, messages, tools, tool_choice: 'auto', parallel_tool_calls: false,
    });
  }

  const content = response.choices[0]?.message?.content
    || 'Sorry, could you say that again?';
  // Keep only what the customer and the agent actually said.
  //
  // Tool calls and their results are deliberately NOT kept. They are transient working
  // notes, and everything worth remembering already lives on the session and the adapter.
  // Keeping them meant a trimmed history could hold a `tool` message whose `tool_calls`
  // had been cut away, which OpenAI rejects outright:
  //   "messages with role 'tool' must be a response to a preceeding message with 'tool_calls'"
  // — every conversation died on its fifth turn.
  const spoken = [
    ...messages.slice(1),
    { role: 'assistant', content } as OpenAI.Chat.ChatCompletionMessageParam,
  ].filter((m) => (m.role === 'user' || m.role === 'assistant')
    && !(m as any).tool_calls
    && typeof (m as any).content === 'string'
    && String((m as any).content).trim().length > 0);
  session.history = spoken.slice(-20) as OpenAI.Chat.ChatCompletionMessageParam[];

  return {
    content,
    diary: adapter.label,
    needsHumanAssistance: Boolean(session.messageTaken && !session.bookingReference),
  };
}
