/**
 * Poole / AutoSage chat diary adapter.
 *
 * A thin wrapper over pooleApi.ts, which already exposes one function per operation. The
 * shape is a DRAFT BOOKING: create a draft, add services to it, list its slots, reserve
 * one, then confirm. Nothing is booked until confirm returns — the reservation is a soft
 * hold that is revalidated at confirm and can still be lost.
 *
 * Poole can do three things Garage Hive cannot: retrieve, reschedule and cancel an
 * existing booking. Those are in the interface because of this adapter, not despite it.
 *
 * Reads pooleApi.ts; modifies nothing.
 */

import {
  addServicesToBooking, cancelBooking, confirmBooking, createDraftBooking, findCustomerByPhone,
  getBooking, getBranches, listAvailableSlots, listServices, lookupVehicleByVrm,
  rescheduleBooking, reserveSlot,
} from '../pooleApi.js';
import {
  type ChatDiaryAdapter, type ChatDiaryCapabilities, type DiaryBooking, type DiaryBranch,
  type DiaryContact, type DiaryCustomer, type DiaryService, type DiarySlot, type DiaryVehicle,
  DiaryError,
} from './types.js';

export interface PooleConfig {
  branchKey?: string;
  tenant?: string;
  branchCode?: string;
}

function slotLabel(date: string, time: string): string {
  try {
    const d = new Date(`${date}T${time}:00`);
    return `${d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })} at ${time}`;
  } catch {
    return `${date} ${time}`;
  }
}

export class PooleChatDiary implements ChatDiaryAdapter {
  readonly label = 'Poole (AutoSage)';

  readonly capabilities: ChatDiaryCapabilities = {
    bookings: true,
    quotePrices: true,
    retrieveBooking: true,
    reschedule: true,
    cancel: true,
    customerLookup: true,
    vehicleLookup: true,
    tyreSales: false,
    basket: false,
    branches: true,
    advisories: false,
    serviceHistory: false,
    // AutoSage requires customer.lastName and vehicle.registration. The address is not
    // sent, so asking for a postcode would be a question whose answer we discard.
    needsAddress: false,
    needsEmail: false,
  };

  private readonly branchKey: string;
  private readonly tenant: string;
  private readonly branchCode?: string;

  /** The draft. Poole hangs every later step off this reference, and it expires after
   *  about four hours — so a half-finished draft must never be promised as a booking. */
  private draftRef = '';
  private services: DiaryService[] = [];
  private chosen: DiaryService[] = [];
  private vehicle: DiaryVehicle | null = null;

  constructor(config: PooleConfig) {
    this.branchKey = String(config.branchKey || '').trim();
    this.tenant = String(config.tenant || '').trim();
    this.branchCode = config.branchCode;
  }

  get enabled(): boolean {
    return Boolean(this.branchKey);
  }

  private assertEnabled(): void {
    if (!this.enabled) throw new DiaryError('Poole is not configured for this garage');
  }

  private async draft(registration: string): Promise<string> {
    if (this.draftRef) return this.draftRef;
    try {
      const { bookingRef } = await createDraftBooking(
        this.branchKey, this.tenant, `chat-${Date.now()}`, this.branchCode);
      this.draftRef = bookingRef;
      return bookingRef;
    } catch (e: any) {
      throw new DiaryError(`could not open a booking: ${e?.message || e}`);
    }
  }

  async branches(): Promise<DiaryBranch[]> {
    this.assertEnabled();
    const list = await getBranches(this.branchKey, this.tenant);
    return (list || []).map((b: any) => ({ key: String(b.code ?? b.id ?? ''), name: String(b.name ?? '') }));
  }

  async lookupVehicle(registration: string): Promise<DiaryVehicle | null> {
    this.assertEnabled();
    try {
      const v: any = await lookupVehicleByVrm(this.branchKey, this.tenant, registration);
      if (!v) return null;
      // The DVLA-sourced lookup gives make and colour but usually an EMPTY model. That is
      // fine: AutoSage treats the model as optional and only requires the registration.
      this.vehicle = {
        registration,
        make: String(v.make || ''),
        model: String(v.model || ''),
        description: [v.make, v.model].filter(Boolean).join(' '),
        raw: v,
      };
      return this.vehicle;
    } catch {
      return null;
    }
  }

  async findCustomerByPhone(phone: string): Promise<DiaryCustomer | null> {
    this.assertEnabled();
    try {
      const found: any[] = await findCustomerByPhone(this.branchKey, this.tenant, phone);
      const c = (found || [])[0];
      if (!c) return null;
      return {
        name: [c.firstName, c.lastName].filter(Boolean).join(' '),
        phone, email: c.email, raw: c,
      };
    } catch {
      return null;
    }
  }

  async offerServices(registration: string): Promise<DiaryService[]> {
    this.assertEnabled();
    const ref = await this.draft(registration);
    let list: any[];
    try {
      list = await listServices(this.branchKey, this.tenant, ref);
    } catch (e: any) {
      throw new DiaryError(`could not list services: ${e?.message || e}`);
    }
    this.services = (list || []).map((s: any) => ({
      key: String(s.id ?? s.serviceId ?? ''),
      name: String(s.name || s.description || '').trim(),
      price: typeof s.price === 'number' ? s.price : undefined,
      raw: s,
    })).filter((s) => s.key);
    return this.services;
  }

  async offerSlots(serviceKeys: string[], opts?: { fromDate?: string }): Promise<DiarySlot[]> {
    this.assertEnabled();
    if (!this.draftRef) throw new DiaryError('no booking open — list the services first');
    const ids = (serviceKeys || []).map((k) => Number(k)).filter((n) => !Number.isNaN(n));
    if (ids.length === 0) throw new DiaryError('at least one service must be chosen');

    this.chosen = this.services.filter((s) => serviceKeys.includes(s.key));
    try {
      // addServices takes the whole list, so a customer wanting two jobs keeps both.
      await addServicesToBooking(this.branchKey, this.tenant, this.draftRef, ids);
    } catch (e: any) {
      throw new DiaryError(`could not add the service: ${e?.message || e}`);
    }

    let days: any[];
    try {
      days = await listAvailableSlots(this.branchKey, this.tenant, this.draftRef, opts?.fromDate);
    } catch (e: any) {
      throw new DiaryError(`could not get availability: ${e?.message || e}`);
    }

    const out: DiarySlot[] = [];
    for (const day of days || []) {
      const date = String(day.date || '');
      for (const time of (day.times || day.slots || []) as string[]) {
        const t = String(time).slice(0, 5);
        out.push({ key: `${date}|${t}`, startIso: `${date}T${t}`, label: slotLabel(date, t) });
      }
    }
    return out;
  }

  async confirm(slotKey: string, contact: DiaryContact): Promise<DiaryBooking> {
    this.assertEnabled();
    if (!this.draftRef) throw new DiaryError('no booking open');
    const [date, time] = String(slotKey || '').split('|');
    if (!date || !time) throw new DiaryError("slot key must be 'YYYY-MM-DD|HH:MM'");

    try {
      await reserveSlot(this.branchKey, this.tenant, this.draftRef, date, time);
    } catch (e: any) {
      throw new DiaryError(`that slot was refused: ${e?.message || e}`);
    }

    const parts = String(contact.name || '').trim().split(/\s+/);
    let detail: any;
    try {
      detail = await confirmBooking(
        this.branchKey, this.tenant, this.draftRef,
        {
          firstName: parts[0] || contact.name || '',
          // lastName is REQUIRED: without it the whole body fails to bind and AutoSage
          // replies "The model field is required", which reads like a missing vehicle
          // model and is nothing of the sort.
          lastName: parts.slice(1).join(' ') || '-',
          phone: contact.phone,
          email: contact.email,
        } as any,
        {
          registration: (this.vehicle?.registration || '').toUpperCase(),
          make: this.vehicle?.make || '',
          model: this.vehicle?.model || '',
        } as any,
        contact.mileage ? Number(contact.mileage) : undefined,
      );
    } catch (e: any) {
      throw new DiaryError(`the booking was not accepted: ${e?.message || e}`);
    }

    this.draftRef = '';
    return {
      reference: String(detail?.bookingRef || detail?.reference || ''),
      whenIso: `${date}T${time}`,
      serviceName: this.chosen.map((s) => s.name).filter(Boolean).join(', '),
      raw: detail,
    };
  }

  async retrieveBooking(reference: string): Promise<DiaryBooking | null> {
    this.assertEnabled();
    try {
      const b: any = await getBooking(this.branchKey, this.tenant, reference);
      if (!b) return null;
      return {
        reference: String(b.bookingRef || reference),
        whenIso: String(b.startsAt || b.date || ''),
        serviceName: (b.services || []).map((s: any) => s.name).filter(Boolean).join(', '),
        raw: b,
      };
    } catch {
      return null;
    }
  }

  async reschedule(reference: string, slotKey: string): Promise<DiaryBooking> {
    this.assertEnabled();
    const [date, time] = String(slotKey || '').split('|');
    if (!date || !time) throw new DiaryError("slot key must be 'YYYY-MM-DD|HH:MM'");
    try {
      const b: any = await rescheduleBooking(this.branchKey, this.tenant, reference, date, time);
      return { reference: String(b?.bookingRef || reference), whenIso: `${date}T${time}`, raw: b };
    } catch (e: any) {
      throw new DiaryError(`could not move that booking: ${e?.message || e}`);
    }
  }

  async cancel(reference: string, reason: string): Promise<boolean> {
    this.assertEnabled();
    try {
      await cancelBooking(this.branchKey, this.tenant, reference, reason);
      return true;
    } catch (e: any) {
      throw new DiaryError(`could not cancel that booking: ${e?.message || e}`);
    }
  }

  flowPrompt(): string {
    return [
      'BOOKING (Poole / AutoSage) — services then a slot:',
      '1. Get the registration and confirm it back.',
      '2. offer_services opens the booking and returns what this garage can do for that ',
      '   vehicle. Quote only from that list; never estimate.',
      '3. Pass EVERY service they asked for together — this diary takes a list, and half ',
      '   a request is a failed booking.',
      '4. Get availability FIRST, then offer one or two real times. Do not ask which day ',
      '   suits before you have times to offer — you cannot act on the answer, and asking ',
      '   again is how the conversation stalls.',
      '5. Collect their name and number, read the booking back, then confirm.',
      '6. Say "booked" only after the confirm succeeds.',
    ].join('\n');
  }

  promptFragment(): string {
    return [
      "THIS GARAGE'S DIARY (Poole / AutoSage):",
      '- Holding a slot is NOT a booking. It is re-checked at confirm and can still be ',
      '  taken; if it is, apologise once and offer the next nearest.',
      '- An unconfirmed booking expires after about four hours, so never leave one ',
      '  half-finished and promise to come back to it.',
      '- You CAN move or cancel an existing booking given its reference.',
      '- No postcode is needed — the booking does not carry an address.',
    ].join('\n');
  }
}
