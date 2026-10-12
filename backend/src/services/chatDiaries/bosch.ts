/**
 * Bosch Car Service chat diary adapter.
 *
 * Wraps boschClient.ts (the Mobility Media / BCSUK REST API). One adapter instance is ONE
 * garage, identified by its service-point UUID (cfg.boschSpoId) — the same per-garage shape
 * as CAM's siteKey and Poole's branchKey. Bosch Car Service is a network of ~160 UK garages
 * on one shared platform, so a single adapter + one spoId per garage covers all of them.
 *
 * ── Capabilities reflect a real end-to-end capture (Pd Vehicle Services, 2026-10-12) ──
 * We booked and then hand-cancelled a real appointment through these exact calls. What that
 * proved, and what it ruled out:
 *   bookings      YES — cart -> vehicle -> lock -> checkout, all anonymous with the static token.
 *   quotePrices   YES — fixprice (MOT etc.) needs no vehicle; calcprice (servicing) needs the
 *                 vehicle's brand+age, which the caller must supply (display lookup is captcha-gated).
 *   cancel/       NO  — booking/{code}/cancel is 401 Access Denied; cancellation needs the
 *   reschedule/         customer's emailed token or a MyBCS login. An agent that books here
 *   retrieve            cannot un-book. Declared off until we solve auth.
 *   vehicleLookup NO  — the make/model/age lookup is behind hCaptcha. We attach the plate blind.
 *
 * ── commitMode: the same safety guard as CAM ──────────────────────────────────
 * 'message' (default) runs the whole conversation — quote, availability — but takes a message
 * instead of committing, so a live/test line CANNOT create a real booking in a garage's diary.
 * 'live' actually books, and is opt-in PER GARAGE (cfg.bosch.commitLive === true) once a
 * supervised booking has been confirmed end to end. The lock step reserves a real slot the
 * instant it runs, so it too is gated behind 'live'.
 *
 * Reads boschClient.ts; modifies nothing else.
 */

import {
  boschClientFromConfig, BoschError, BCS_SERVICES, type BoschClient, type BoschSlot,
} from '../boschClient.js';
import {
  type ChatDiaryAdapter, type ChatDiaryCapabilities, type DiaryBooking, type DiaryContact,
  type DiaryService, type DiarySlot, DiaryError,
} from './types.js';

/** How far ahead to ask for availability in one go. */
const WINDOW_DAYS = 28;

function isoDay(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function slotLabel(startIso: string): string {
  try {
    const d = new Date(startIso);
    const day = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    const time = d.toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true });
    return `${day} at ${time}`;
  } catch {
    return startIso;
  }
}

export class BoschChatDiary implements ChatDiaryAdapter {
  readonly label = 'Bosch Car Service';

  readonly capabilities: ChatDiaryCapabilities = {
    bookings: true,
    quotePrices: true,
    // Proven unreachable: cancel/retrieve are 401 without the customer's email token.
    retrieveBooking: false,
    reschedule: false,
    cancel: false,
    customerLookup: false,
    // The reg->make/model lookup is captcha-gated; we attach the plate without displaying it.
    vehicleLookup: false,
    tyreSales: false,
    basket: false,
    // One adapter instance is one service point, so no in-conversation branch choice.
    branches: false,
    advisories: false,
    serviceHistory: false,
    needsAddress: false,
    // checkout 400s without consumer.email.
    needsEmail: true,
  };

  private readonly client: BoschClient | null;
  private readonly commitMode: 'message' | 'live';

  /** Services offered to the caller this turn, by DiaryService.key (the numeric service id). */
  private services: DiaryService[] = [];
  /** Slots offered this turn, by DiarySlot.key, so confirm() recovers the raw slot (and its
   *  services array) without the agent ever seeing it. */
  private offered = new Map<string, BoschSlot>();
  private registration = '';

  constructor(config: unknown) {
    this.client = boschClientFromConfig(config);
    const raw = (config && typeof config === 'object' ? config : {}) as any;
    this.commitMode = (raw.bosch?.commitLive ?? raw.boschCommitLive) === true ? 'live' : 'message';
  }

  get enabled(): boolean {
    return Boolean(this.client && this.client.isEnabled());
  }

  private need(): BoschClient {
    if (!this.client || !this.client.isEnabled()) {
      throw new DiaryError('Bosch Car Service is not configured for this garage');
    }
    return this.client;
  }

  /**
   * What this garage can do, with fixprice prices filled in.
   *
   * `opts.brand` + `opts.ageYears` unlock calcprice quoting (Car Servicing etc.); without
   * them those services are still offered, just without a price (the agent books them as an
   * enquiry). `registration` is remembered for confirm().
   */
  async offerServices(
    registration: string,
    opts?: { mileage?: number; brand?: string; ageYears?: number },
  ): Promise<DiaryService[]> {
    this.registration = String(registration || '').trim();
    const client = this.need();

    const ids = Object.keys(BCS_SERVICES).map(Number);
    const out = await Promise.all(ids.map(async (id) => {
      const meta = BCS_SERVICES[id];
      try {
        if (!(await client.offersService(id))) return null;
      } catch {
        return null;
      }
      let price: number | undefined;
      try {
        if (meta.type === 'fixprice') {
          price = await client.fixPrice(id);
        } else if (meta.type === 'calcprice' && opts?.brand && typeof opts.ageYears === 'number') {
          price = await client.calcPrice(id, opts.brand, opts.ageYears);
        }
      } catch {
        price = undefined;
      }
      return { key: String(id), name: meta.name, price, raw: meta } as DiaryService;
    }));

    this.services = out.filter((s): s is DiaryService => s !== null);
    return this.services;
  }

  async offerSlots(serviceKeys: string[], opts?: { fromDate?: string }): Promise<DiarySlot[]> {
    const id = Number((serviceKeys || [])[0]);
    if (Number.isNaN(id)) throw new DiaryError('at least one service must be chosen');
    // Bosch books one service per diary slot; take the first and note the limitation.
    const from = opts?.fromDate && opts.fromDate > isoDay(0) ? opts.fromDate : isoDay(0);
    const to = isoDay(WINDOW_DAYS);

    let slots: BoschSlot[];
    try {
      slots = await this.need().slots(id, from, to);
    } catch (e: any) {
      throw new DiaryError(`could not get availability: ${e?.message || e}`);
    }

    this.offered.clear();
    const out: DiarySlot[] = [];
    for (const s of slots) {
      const key = `${s.start.slice(0, 10)}|${s.start.slice(11, 16)}`;
      this.offered.set(key, s);
      out.push({ key, startIso: s.start, label: slotLabel(s.start), raw: s });
    }
    return out;
  }

  async confirm(slotKey: string, contact: DiaryContact): Promise<DiaryBooking> {
    const slot = this.offered.get(slotKey);
    if (!slot) throw new DiaryError('Bosch confirm: that slot was not one we offered this call');
    if (!contact.email) throw new DiaryError('Bosch needs an email address to confirm a booking');

    const id = Number((slot.services?.[0] as any)?.serviceId) || 18000;
    const serviceName = BCS_SERVICES[id]?.name;

    // Message mode: do not touch the diary. The agent takes a message instead. This is what
    // keeps a live/test line from booking a real garage before that garage is opted in.
    if (this.commitMode !== 'live') {
      throw new DiaryError(
        'Bosch booking is in message mode for this garage — take the caller\'s details as a message',
      );
    }

    const [firstName, ...rest] = String(contact.name || '').trim().split(/\s+/);
    const client = this.need();
    try {
      const cartId = await client.createCart(id);
      if (this.registration) await client.attachVehicle(cartId, this.registration);
      const slotId = await client.lockSlot(slot);
      const booking = await client.checkout({
        cartId, slot, slotId,
        firstName: firstName || 'Customer',
        lastName: rest.join(' ') || '-',
        email: contact.email,
        phone: contact.phone,
        problemDescription: contact.notes,
      });
      return { reference: booking.bookingCode, whenIso: slot.start, serviceName, raw: booking.raw };
    } catch (e: any) {
      if (e instanceof BoschError) throw new DiaryError(`the booking was not accepted: ${e.message}`);
      throw new DiaryError(`the booking was not accepted: ${e?.message || e}`);
    }
  }

  flowPrompt(): string {
    return [
      'BOOKING (Bosch Car Service) — services first, then a slot:',
      '1. Get the registration and confirm it back.',
      '2. offer_services returns what this garage can do, with prices where it has them. ',
      '   Quote only from it. Some services (servicing, brakes) may come back without a price ',
      '   — offer those as a booking, and say the price is confirmed at the garage.',
      '3. Get availability FIRST, then offer one or two real times. Do not ask which day ',
      '   suits before you have times to offer.',
      '4. Collect their name, number and EMAIL — the booking is refused without an email. ',
      '   Read the booking back, then confirm.',
      '5. Say "booked" only after the confirm succeeds, and give them the booking code.',
    ].join('\n');
  }

  promptFragment(): string {
    return [
      "THIS GARAGE'S DIARY (Bosch Car Service):",
      '- An email address is REQUIRED to book. No email, no booking — ask for it.',
      '- You CANNOT cancel or move a booking from here. If they need to change one, tell ',
      '  them to use the link in their confirmation email or to phone the garage directly.',
      '- Bookings are a REQUEST the garage confirms — say you have requested the appointment, ',
      '  not that it is guaranteed.',
    ].join('\n');
  }
}
