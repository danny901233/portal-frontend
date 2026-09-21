/**
 * Chat diary adapters — one chat agent, many booking systems.
 *
 * The portal runs four forked chat agents today (chatAgentV2 for Garage Hive, plus
 * Tyresoft, Bookar and Poole) totalling ~10,700 lines that drift apart silently. This is
 * the same abstraction the unified voice agent uses: everything a garage's booking system
 * does sits behind one interface, and the agent never knows which one it is talking to.
 *
 * The interface is the UNION of what the four agents can do, not what Garage Hive can do.
 * That distinction cost real functionality on the voice side: building the tool list from
 * the benchmark alone left Bookar and Poole declaring reschedule and cancel while having
 * no way to reach them. Every capability below exists in at least one production chat
 * agent, and `Capabilities` says which diary can honour which.
 *
 * Nothing here imports or modifies a production chat agent.
 */

/** What this diary can actually do. False means the tool is not offered and the prompt
 *  block that names it is not injected — an agent must never be told to call something it
 *  does not have. */
export interface ChatDiaryCapabilities {
  /** Can take a new booking at all. */
  bookings: boolean;
  /** Returns real prices, not just a service list. */
  quotePrices: boolean;
  /** Can look a booking up by reference. */
  retrieveBooking: boolean;
  /** Can move an existing booking. */
  reschedule: boolean;
  /** Can cancel an existing booking. */
  cancel: boolean;
  /** Can find a customer from their phone number, so we greet them by name. */
  customerLookup: boolean;
  /** Can look a vehicle up from its registration. */
  vehicleLookup: boolean;
  /** Sells tyres from a stock feed as well as booking work. */
  tyreSales: boolean;
  /** Builds a multi-line basket (tyres and services together) before booking. */
  basket: boolean;
  /** Has more than one branch to choose between. */
  branches: boolean;
  /** Returns outstanding health-check advisories for a vehicle. */
  advisories: boolean;
  /** Returns what the vehicle last had done. */
  serviceHistory: boolean;
  /** The booking carries a postal address, so it is worth asking for one. */
  needsAddress: boolean;
  /** The diary REJECTS a booking with no email. Not a nice-to-have: without it the confirm
   *  comes back 400 and the customer is asked their name again forever. */
  needsEmail: boolean;
}

export const NO_CAPABILITIES: ChatDiaryCapabilities = {
  bookings: false, quotePrices: false, retrieveBooking: false, reschedule: false,
  cancel: false, customerLookup: false, vehicleLookup: false, tyreSales: false,
  basket: false, branches: false, advisories: false, serviceHistory: false,
  needsAddress: false, needsEmail: false,
};

/** Deliberately plain shapes. Adapters translate their API into these; the agent above
 *  never sees a diary's own JSON. */
export interface DiaryService {
  /** Opaque id the adapter understands — a Garage Hive servicePriceID, a Tyresoft
   *  service id. The agent passes it back and never parses it. */
  key: string;
  name: string;
  price?: number;
  durationMinutes?: number;
  raw?: unknown;
}

export interface DiarySlot {
  /** "YYYY-MM-DD|HH:MM" — opaque to the agent, meaningful to the adapter. */
  key: string;
  startIso: string;
  /** How to say it out loud: "Thursday the 10th at 9 in the morning". */
  label: string;
  raw?: unknown;
}

export interface DiaryVehicle {
  registration: string;
  make?: string;
  model?: string;
  description?: string;
  motExpiry?: string;
  onFile?: boolean;
  /** Tyre sizes on record, so we never ask a customer to read their sidewall when the
   *  diary already knows. */
  tyreSizes?: string[];
  raw?: unknown;
}

export interface DiaryCustomer {
  name?: string;
  phone?: string;
  email?: string;
  vehicles?: DiaryVehicle[];
  raw?: unknown;
}

export interface DiaryBooking {
  reference: string;
  whenIso: string;
  serviceName?: string;
  raw?: unknown;
}

export interface DiaryTyre {
  stockNumber: string;
  brand: string;
  title: string;
  /** Already marked up by the adapter — nothing downstream re-prices it. */
  price: number;
  size?: string;
  /** premium | mid-range | budget, by brand and never by price: a budget marque in an odd
   *  size can cost more than a premium one in a common size. */
  tier?: string;
  leadTimeDays?: number;
  raw?: unknown;
}

export interface DiaryBasketLine {
  kind: 'tyre' | 'service';
  description: string;
  quantity: number;
  unitPrice: number;
  ref?: string;
  leadTimeDays?: number;
}

export interface DiaryContact {
  name: string;
  phone: string;
  email?: string;
  address?: string;
  postcode?: string;
  city?: string;
  mileage?: string;
  notes?: string;
}

export interface DiaryBranch {
  key: string;
  name: string;
}

/** Anything the diary refused or could not do. The agent turns this into a message the
 *  customer can act on — never a stack trace, and never silence. */
export class DiaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiaryError';
  }
}

/**
 * One garage's booking system.
 *
 * Every method throws DiaryError when the diary cannot do it. Anything the diary does not
 * support at all is answered by `capabilities`, so the agent can decide before asking.
 */
export interface ChatDiaryAdapter {
  readonly label: string;
  readonly capabilities: ChatDiaryCapabilities;
  /** False when credentials are missing. The agent still answers and takes messages. */
  readonly enabled: boolean;

  // ── Taking a booking ──────────────────────────────────────────────────────
  offerServices(registration: string, opts?: { mileage?: number }): Promise<DiaryService[]>;
  /**
   * Availability for EVERY service the customer asked for, together.
   *
   * Always a list, never a single key. All four diaries take more than one service on a
   * booking — Garage Hive's set-services accepts an array, Bookar takes service_ids[],
   * Poole has add_services, Tyresoft puts them on a basket — and someone asking for "an
   * MOT and the brakes looked at" must not lose half their request. Splitting a two-part
   * booking was the single most repeated failure in the voice agent's simulations, and it
   * started with a signature that could only hold one.
   */
  offerSlots(serviceKeys: string[], opts?: { fromDate?: string }): Promise<DiarySlot[]>;
  /** Every slot the diary has, for "what else have you got?" — Tyresoft and Poole both
   *  expose this separately from the first page of availability. */
  allSlots?(serviceKeys: string[]): Promise<DiarySlot[]>;
  /** Is this specific day/time free? Cheaper than listing everything. */
  checkSlot?(slotKey: string): Promise<boolean>;
  confirm(slotKey: string, contact: DiaryContact): Promise<DiaryBooking>;

  // ── Changing one ──────────────────────────────────────────────────────────
  retrieveBooking?(reference: string): Promise<DiaryBooking | null>;
  reschedule?(reference: string, slotKey: string): Promise<DiaryBooking>;
  cancel?(reference: string, reason: string): Promise<boolean>;

  // ── Who and what ──────────────────────────────────────────────────────────
  lookupVehicle?(registration: string): Promise<DiaryVehicle | null>;
  findCustomerByPhone?(phone: string): Promise<DiaryCustomer | null>;
  advisories?(registration: string): Promise<{ description: string; price?: number }[]>;
  serviceHistory?(registration: string, mileage?: number): Promise<Record<string, unknown>>;
  branches?(): Promise<DiaryBranch[]>;
  selectBranch?(key: string): Promise<void>;

  // ── Tyres, for the diaries that sell them ─────────────────────────────────
  searchTyres?(size: string, opts: { position?: string; quality?: string; brand?: string }):
    Promise<DiaryTyre[]>;
  addTyre?(tyre: DiaryTyre, quantity: number): Promise<DiaryBasketLine>;
  addServiceLine?(serviceKey: string): Promise<DiaryBasketLine>;
  basketLines?(): DiaryBasketLine[];
  clearBasket?(): void;

  // ── Prompt ────────────────────────────────────────────────────────────────
  /** The ordered booking steps, in this diary's tool names. Shared prompt text stays
   *  diary-agnostic; this is where the differences live. Leaving one diary's flow in the
   *  shared prompt is how every other diary silently inherits it. */
  flowPrompt(): string;
  /** What is peculiar to this booking system — Bookar not booking same-day, Poole's draft
   *  expiring after four hours. Quirks only; never the flow. */
  promptFragment(): string;
}
