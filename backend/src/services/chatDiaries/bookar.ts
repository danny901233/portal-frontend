/**
 * Bookar (Vitara Commerce) chat diary adapter.
 *
 * A thin wrapper over bookarClient.ts, which already handles OAuth and retries. Bookar is
 * STATELESS: no session, no draft — availability is asked for by service ids and a date
 * range, and the booking is one POST carrying everything. That is a third shape again,
 * after Garage Hive's session and Poole's draft, and the reason the adapter interface has
 * to hide shape rather than assume it.
 *
 * Like Poole, Bookar can retrieve, reschedule and cancel — capabilities the Garage Hive
 * benchmark has no equivalent of.
 *
 * Reads bookarClient.ts; modifies nothing.
 */

import { bookarClientFromConfig } from '../bookarClient.js';
import {
  type ChatDiaryAdapter, type ChatDiaryCapabilities, type DiaryBooking, type DiaryContact,
  type DiaryCustomer, type DiaryService, type DiarySlot, type DiaryVehicle, DiaryError,
} from './types.js';

/** Bookar will not take a booking for today — the earliest it fits anyone in is tomorrow. */
const LEAD_DAYS = 1;
/** How far ahead to ask for availability in one go. */
const WINDOW_DAYS = 28;

function isoDay(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function slotLabel(date: string, time: string): string {
  try {
    const d = new Date(`${date}T${time}:00`);
    return `${d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })} at ${time}`;
  } catch {
    return `${date} ${time}`;
  }
}

export class BookarChatDiary implements ChatDiaryAdapter {
  readonly label = 'Bookar';

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
    // The booking body carries customer, vehicle, service ids and a slot. No address.
    needsAddress: false,
    // POST /v1/bookings returns 400 'customer.email is required' without one.
    needsEmail: true,
  };

  private readonly client: ReturnType<typeof bookarClientFromConfig>;
  private services: DiaryService[] = [];
  private chosen: DiaryService[] = [];
  private vehicle: DiaryVehicle | null = null;

  constructor(integrationProviderConfig: unknown) {
    this.client = bookarClientFromConfig(integrationProviderConfig);
  }

  get enabled(): boolean {
    return Boolean(this.client && this.client.isEnabled());
  }

  private need() {
    if (!this.client || !this.client.isEnabled()) {
      throw new DiaryError('Bookar is not configured for this garage');
    }
    return this.client;
  }

  async lookupVehicle(registration: string): Promise<DiaryVehicle | null> {
    try {
      const v: any = await this.need().lookupVehicle(registration);
      if (!v) return null;
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
    try {
      const c: any = await this.need().findCustomerByPhone(phone);
      if (!c) return null;
      return { name: c.name, phone, email: c.email, raw: c };
    } catch {
      return null;
    }
  }

  async offerServices(registration: string): Promise<DiaryService[]> {
    let list: any[];
    try {
      list = await this.need().listServices(registration);
    } catch (e: any) {
      throw new DiaryError(`could not list services: ${e?.message || e}`);
    }
    this.services = (list || []).map((s: any) => ({
      key: String(s.id ?? s.service_id ?? ''),
      name: String(s.name || s.description || '').trim(),
      // Bookar returns price as an object, not a number: reading it flat gives NaN and
      // quotes the customer nothing.
      price: typeof s.price === 'number' ? s.price
        : typeof s.price?.total === 'number' ? s.price.total : undefined,
      durationMinutes: typeof s.duration_minutes === 'number' ? s.duration_minutes : undefined,
      raw: s,
    })).filter((s) => s.key);
    return this.services;
  }

  async offerSlots(serviceKeys: string[], opts?: { fromDate?: string }): Promise<DiarySlot[]> {
    const ids = (serviceKeys || []).map((k) => Number(k)).filter((n) => !Number.isNaN(n));
    if (ids.length === 0) throw new DiaryError('at least one service must be chosen');
    this.chosen = this.services.filter((s) => serviceKeys.includes(s.key));

    // Never offer today: this garage needs a day's notice, and offering a slot it will
    // refuse wastes the customer's time twice.
    const from = opts?.fromDate && opts.fromDate > isoDay(LEAD_DAYS) ? opts.fromDate : isoDay(LEAD_DAYS);
    const to = isoDay(LEAD_DAYS + WINDOW_DAYS);

    let days: any[];
    try {
      days = await this.need().listAvailability(ids, from, to);
    } catch (e: any) {
      throw new DiaryError(`could not get availability: ${e?.message || e}`);
    }

    const out: DiarySlot[] = [];
    for (const day of days || []) {
      const date = String(day.date || '');
      const times: string[] = Array.isArray(day.slots) ? day.slots : day.time ? [day.time] : [];
      for (const time of times) {
        const t = String(time).slice(0, 5);
        if (date < from) continue;
        out.push({ key: `${date}|${t}`, startIso: `${date}T${t}`, label: slotLabel(date, t) });
      }
    }
    return out;
  }

  async confirm(slotKey: string, contact: DiaryContact): Promise<DiaryBooking> {
    const [date, time] = String(slotKey || '').split('|');
    if (!date || !time) throw new DiaryError("slot key must be 'YYYY-MM-DD|HH:MM'");
    const ids = this.chosen.map((s) => Number(s.key)).filter((n) => !Number.isNaN(n));
    if (ids.length === 0) throw new DiaryError('no service chosen');

    const parts = String(contact.name || '').trim().split(/\s+/);
    let res: any;
    try {
      res = await this.need().createBooking({
        customer: {
          first_name: parts[0] || contact.name || '',
          last_name: parts.slice(1).join(' ') || '-',
          phone: contact.phone,
          email: contact.email,
        } as any,
        vehicle: {
          vrm: (this.vehicle?.registration || '').toUpperCase() || undefined,
          mileage: contact.mileage ? Number(contact.mileage) : undefined,
        },
        service_ids: ids,
        slot: { date, time } as any,
      });
    } catch (e: any) {
      throw new DiaryError(`the booking was not accepted: ${e?.message || e}`);
    }

    return {
      reference: String(res?.reference || ''),
      whenIso: `${date}T${time}`,
      serviceName: this.chosen.map((s) => s.name).filter(Boolean).join(', '),
      raw: res,
    };
  }

  async retrieveBooking(reference: string): Promise<DiaryBooking | null> {
    try {
      const b: any = await this.need().retrieveBooking(reference);
      if (!b) return null;
      const when = b.appointment ? `${b.appointment.date}T${b.appointment.time}` : '';
      return { reference: String(b.reference || reference), whenIso: when, raw: b };
    } catch {
      return null;
    }
  }

  async reschedule(reference: string, slotKey: string): Promise<DiaryBooking> {
    const [date, time] = String(slotKey || '').split('|');
    if (!date || !time) throw new DiaryError("slot key must be 'YYYY-MM-DD|HH:MM'");
    try {
      const b: any = await this.need().rescheduleBooking(reference, { date, time } as any);
      return { reference: String(b?.reference || reference), whenIso: `${date}T${time}`, raw: b };
    } catch (e: any) {
      throw new DiaryError(`could not move that booking: ${e?.message || e}`);
    }
  }

  async cancel(reference: string, reason: string): Promise<boolean> {
    try {
      await this.need().cancelBooking(reference, reason);
      return true;
    } catch (e: any) {
      throw new DiaryError(`could not cancel that booking: ${e?.message || e}`);
    }
  }

  flowPrompt(): string {
    return [
      'BOOKING (Bookar) — services first, then a slot:',
      '1. Get the registration and confirm it back.',
      '2. offer_services returns what this garage can do for that vehicle, with prices. ',
      '   Quote only from it.',
      '3. Pass EVERY service they asked for together — availability is worked out for the ',
      '   whole job, and asking for one at a time gives the wrong times.',
      '4. Get availability FIRST, then offer one or two real times. Do not ask which day ',
      '   suits before you have times to offer — you cannot act on the answer, and asking ',
      '   again is how the conversation stalls.',
      '5. Collect their name and number, read the booking back, then confirm.',
      '6. Say "booked" only after the confirm succeeds.',
    ].join('\n');
  }

  promptFragment(): string {
    return [
      "THIS GARAGE'S DIARY (Bookar):",
      '- It will not take a booking for today. The earliest is tomorrow — if they ask for ',
      '  today, say so plainly and offer tomorrow.',
      '- You CAN move or cancel an existing booking given its reference. Read back what ',
      '  you are about to change before you change it.',
      '- No postcode is needed — the booking does not carry an address.',
    ].join('\n');
  }
}
