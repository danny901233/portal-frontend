/**
 * Garage Hive chat diary adapter.
 *
 * Extracted from chatAgentV2's gh* functions — the benchmark chat agent — without
 * modifying it. Garage Hive's external-booking API is a STATEFUL SESSION: init, set the
 * vehicle, list services, set services, list timeslots, set the timeslot, then contact
 * info commits the booking. Nothing above this file knows that; every other diary is a
 * different shape entirely.
 *
 * Two things done differently from chatAgentV2, both deliberate:
 *
 *   1. Credentials live on the instance. chatAgentV2 keeps GH_CUSTOMER_ID, GH_API_KEY and
 *      GH_LOCATION_ID in module-level `let`s reassigned per garage (chatAgentV2.ts:920 and
 *      again at 2835). A server handling two garages' messages at once can have one
 *      overwrite the other's credentials mid-request. Per-instance state cannot.
 *   2. set-services is given the array it has always accepted. A customer asking for an
 *      MOT and the brakes keeps both.
 */

import axios from 'axios';
import {
  type ChatDiaryAdapter, type ChatDiaryCapabilities, type DiaryBooking, type DiaryContact,
  type DiaryService, type DiarySlot, type DiaryVehicle, DiaryError,
} from './types.js';

const API_ROOT = 'https://onlinebooking.garagehive.co.uk/api/external-booking';

export interface GarageHiveConfig {
  customerId?: string;
  apiKey?: string;
  locationId?: string;
}

/** Spoken/readable label for a slot: "Thursday the 10 September at 9:00". */
function slotLabel(date: string, time: string): string {
  try {
    const d = new Date(`${date}T${time}:00`);
    const day = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    return `${day} at ${time}`;
  } catch {
    return `${date} ${time}`;
  }
}

export class GarageHiveChatDiary implements ChatDiaryAdapter {
  readonly label = 'Garage Hive';

  readonly capabilities: ChatDiaryCapabilities = {
    bookings: true,
    quotePrices: true,
    // The external-booking API has no endpoints for any of these. Declaring them false is
    // what stops the agent offering something it would only fail at.
    retrieveBooking: false,
    reschedule: false,
    cancel: false,
    customerLookup: false,
    vehicleLookup: false,   // the vehicle comes back from set-vehicle-info, not a lookup
    tyreSales: false,
    basket: false,
    branches: true,         // locationId selects a branch within one customer account
    advisories: true,       // via the portal's own health-check endpoint
    serviceHistory: true,   // via the portal's invoice history
    needsAddress: true,     // contact info carries address and postcode
    needsEmail: false,
  };

  private readonly customerId: string;
  private readonly apiKey: string;
  private locationId: string;

  /** The booking session. Garage Hive gives one session id at init and every later step
   *  hangs off it, so it belongs to the adapter, not the conversation. */
  private sessionId = '';
  private services: DiaryService[] = [];
  private chosen: DiaryService[] = [];

  constructor(config: GarageHiveConfig) {
    this.customerId = String(config.customerId || '').trim();
    this.apiKey = String(config.apiKey || '').trim();
    this.locationId = String(config.locationId || '23').trim();
  }

  get enabled(): boolean {
    return Boolean(this.customerId && this.apiKey);
  }

  private get baseUrl(): string {
    return `${API_ROOT}/${this.customerId}`;
  }

  private get headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` };
  }

  private assertEnabled(): void {
    if (!this.enabled) throw new DiaryError('Garage Hive is not configured for this garage');
  }

  /** Drop a half-open session so the next attempt starts cleanly. */
  private reset(): void {
    this.sessionId = '';
    this.services = [];
    this.chosen = [];
  }

  async selectBranch(key: string): Promise<void> {
    // Changing branch invalidates the session: the diary it lists is the branch's.
    if (key && key !== this.locationId) {
      this.locationId = key;
      this.sessionId = '';
    }
  }

  async offerServices(registration: string): Promise<DiaryService[]> {
    this.assertEnabled();
    if (!registration) throw new DiaryError('a registration is needed before services can be listed');

    let init;
    try {
      init = await axios.post(`${this.baseUrl}/init`, {}, { headers: this.headers });
    } catch (e: any) {
      throw new DiaryError(`could not open a booking: ${e?.response?.data?.message || e.message}`);
    }
    const sessionId = init.data?.booking?.session_id || init.data?.sessionId;
    if (!sessionId) throw new DiaryError('Garage Hive returned no session id');
    this.sessionId = sessionId;

    try {
      await axios.post(
        `${this.baseUrl}/${sessionId}/set-vehicle-info`,
        {
          registration_no: registration,
          reg_no_country: 'GB',
          location_id: parseInt(this.locationId, 10),
        },
        { headers: this.headers },
      );
    } catch (e: any) {
      // A session whose vehicle never landed is useless, and holding on to it makes every
      // later step fail with "Booking not found" — which reads like the diary losing the
      // booking rather than us keeping a broken handle. A customer who mistypes their
      // registration and corrects it hits this on the second attempt.
      this.reset();
      throw new DiaryError(
        `could not set the vehicle: ${e?.response?.data?.message || e.message}`);
    }

    let list;
    try {
      list = await axios.get(`${this.baseUrl}/${sessionId}/list-services`,
                             { headers: { Authorization: `Bearer ${this.apiKey}` } });
    } catch (e: any) {
      throw new DiaryError(`could not list services: ${e?.response?.data?.message || e.message}`);
    }

    // The response is snake_case even though set-services wants camelCase back. Reading
    // the wrong one gives an empty id and books nothing.
    this.services = (list.data?.services || []).map((s: any) => ({
      key: String(s.service_price_id ?? s.servicePriceID ?? ''),
      name: String(s.description || s.name || '').trim(),
      price: typeof s.price === 'number' ? s.price : undefined,
      raw: s,
    })).filter((s: DiaryService) => s.key);
    return this.services;
  }

  async offerSlots(serviceKeys: string[]): Promise<DiarySlot[]> {
    this.assertEnabled();
    if (!this.sessionId) throw new DiaryError('no booking open — list the services first');
    const ids = (serviceKeys || []).map((k) => String(k).trim()).filter(Boolean);
    if (ids.length === 0) throw new DiaryError('at least one service must be chosen');

    this.chosen = this.services.filter((s) => ids.includes(s.key));

    try {
      // Always an array. It has accepted one since the beginning, and sending a single id
      // is how the second half of "an MOT and the brakes" goes missing.
      await axios.post(`${this.baseUrl}/${this.sessionId}/set-services`,
                       { servicePriceIDs: ids }, { headers: this.headers });
    } catch (e: any) {
      this.reset();
      throw new DiaryError(`could not set the service: ${e?.response?.data?.message || e.message}`);
    }

    let res;
    try {
      res = await axios.get(`${this.baseUrl}/${this.sessionId}/list-timeslots`,
                            { headers: { Authorization: `Bearer ${this.apiKey}` } });
    } catch (e: any) {
      throw new DiaryError(`could not get availability: ${e?.response?.data?.message || e.message}`);
    }

    // Timeslots come back as an object keyed by date, not a list.
    const out: DiarySlot[] = [];
    const timeslots = res.data?.timeslots || {};
    for (const [date, times] of Object.entries(timeslots)) {
      if (!Array.isArray(times)) continue;
      for (const time of times as string[]) {
        out.push({ key: `${date}|${time}`, startIso: `${date}T${time}`,
                   label: slotLabel(date, time) });
      }
    }
    return out;
  }

  async confirm(slotKey: string, contact: DiaryContact): Promise<DiaryBooking> {
    this.assertEnabled();
    if (!this.sessionId) throw new DiaryError('no booking open');
    const [date, time] = String(slotKey || '').split('|');
    if (!date || !time) throw new DiaryError("slot key must be 'YYYY-MM-DD|HH:MM'");

    try {
      await axios.post(`${this.baseUrl}/${this.sessionId}/set-timeslot`,
                       { bookingDate: date, bookingTime: time }, { headers: this.headers });
    } catch (e: any) {
      throw new DiaryError(`that slot was refused: ${e?.response?.data?.message || e.message}`);
    }

    const [first, ...rest] = String(contact.name || '').trim().split(/\s+/);
    let res;
    try {
      res = await axios.post(
        `${this.baseUrl}/${this.sessionId}/set-contact-info`,
        {
          // Field names are Garage Hive's, taken from the benchmark agent rather than
          // guessed: the first name is contact_NAME, not contact_first_name, and sending
          // the wrong one is answered with 422 ["Please provide Name"].
          contact_name: first || contact.name || 'Customer',
          contact_last_name: rest.join(' '),
          contact_email: contact.email || '',
          contact_number: contact.phone || '',
          contact_address: contact.address || '',
          contact_address2: '',
          // Garage Hive rejects an empty city, so fall back through what we do have
          // before giving it N/A.
          contact_city: (contact.city || contact.address || contact.postcode || '').trim() || 'N/A',
          contact_postcode: contact.postcode || '',
          // 0 is not a valid code, so any garage that marks salutation as required
          // rejects the booking; 10 is the neutral one.
          contact_salutation: 10,
          vehicle_mileage: Number(contact.mileage) || 1,
          notes: contact.notes || '',
        },
        { headers: this.headers },
      );
    } catch (e: any) {
      // The real reason lives in the body — Garage Hive answers 422 with a field-level
      // explanation ("Please provide Salutation") that the status code alone hides.
      const body = e?.response?.data;
      // "Some fields are not filled or have invalid values" names no field, so log what we
      // sent: the payload is the only way to tell which one it meant.
      console.warn('[UNIFIED_CHAT] set-contact-info rejected. sent: '
        + JSON.stringify({ name: first, last: rest.join(' '), email: contact.email || '',
                           number: contact.phone || '', address: contact.address || '',
                           city: (contact.city || contact.address || contact.postcode || '').trim() || 'N/A',
                           postcode: contact.postcode || '', mileage: Number(contact.mileage) || 1 }));
      const detail = body?.message
        || (body?.errors && JSON.stringify(body.errors))
        || (body && JSON.stringify(body).slice(0, 300))
        || e.message;
      throw new DiaryError(`the booking was not accepted: ${detail}`);
    }

    // The id Garage Hive returns IS what the garage sees in its diary, so it is what the
    // customer is told.
    const reference = String(res.data?.booking?.id ?? res.data?.reference ?? '');
    return {
      reference,
      whenIso: `${date}T${time}`,
      serviceName: this.chosen.map((s) => s.name).filter(Boolean).join(', '),
      raw: res.data,
    };
  }

  flowPrompt(): string {
    return [
      'BOOKING (Garage Hive) — quote first, then book:',
      '1. Get the registration and confirm it back before anything else.',
      '2. offer_services returns the real prices for THAT vehicle. Quote only from it, ',
      '   exactly as given — never estimate, round or add VAT.',
      '3. Pass EVERY service they asked for to the availability step together. Someone ',
      '   wanting an MOT and the brakes looked at gets both on one booking; dropping ',
      '   either is the failure.',
      '4. Get availability BEFORE you ask about days. In chat there is no silence to fill, so ',
      '   fetch the real times first and then offer one or two — asking "which day suits?" ',
      '   before you have any times leaves you with nothing to do with the answer, and the ',
      '   conversation goes round in circles asking it again.',
      '5. Collect their details, read the whole booking back, and only then confirm.',
      '6. Say "booked" only after the confirm succeeds — never before.',
      "7. If their service is not in the list you cannot price it, but you can still book ",
      '   it under the "Other"/"General"/"Misc" service; the team prices it afterwards.',
    ].join('\n');
  }

  promptFragment(): string {
    return [
      "THIS GARAGE'S DIARY (Garage Hive):",
      '- You cannot move or cancel an existing booking here. For those, take a message ',
      '  with the booking reference so the team can do it.',
      '- A price that is missing is one the garage chose not to publish — say the team ',
      '  will confirm it, and never guess.',
    ].join('\n');
  }
}
