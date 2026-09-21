/**
 * Tyresoft chat diary adapter.
 *
 * The fourth shape. Tyresoft sells TYRES from a stock feed as well as booking garage work,
 * and both go on one job — someone can have two front tyres and an MOT on the same visit.
 * So this is the only adapter with a basket, and the only one whose prices do not come
 * from the diary at all: tyre stock is a CSV/portal feed, and the service catalogue is the
 * garage's portal configuration rather than an API call.
 *
 * Auth is Basic (username:password) plus an x-api-key header, against a per-workspace URL.
 * The three-call commit is saveCustomer -> saveVehicle -> createSale.
 *
 * Reads chatAgentTyresoft.ts for the API shapes; modifies nothing.
 */

import axios from 'axios';
import {
  type ChatDiaryAdapter, type ChatDiaryCapabilities, type DiaryBasketLine, type DiaryBooking,
  type DiaryContact, type DiaryService, type DiarySlot, type DiaryTyre, type DiaryVehicle,
  DiaryError,
} from './types.js';

const API_ROOT = 'https://3p-api.tyresoft.biz/v1';

export interface TyresoftConfig {
  tsWorkspace?: string;
  tsUsername?: string;
  tsPassword?: string;
  tsApiKey?: string;
  tsDepotId?: number | string;
  tsChannelId?: number | string;
  /** The garage's configured service catalogue — Tyresoft has no endpoint for it. */
  tsServices?: Array<Record<string, unknown>>;
}

/** premium | mid-range | budget, by BRAND. Never by price: a budget marque in an odd size
 *  can cost more than a premium one in a common size, and sorting by price gets it exactly
 *  backwards when it matters. */
const PREMIUM = new Set(['MICHELIN', 'CONTINENTAL', 'PIRELLI', 'GOODYEAR', 'BRIDGESTONE',
  'DUNLOP', 'VREDESTEIN', 'NOKIAN']);
const MID = new Set(['AVON', 'FALKEN', 'HANKOOK', 'KUMHO', 'TOYO', 'YOKOHAMA', 'UNIROYAL',
  'FIRESTONE', 'NEXEN', 'BFGOODRICH', 'COOPER', 'GT RADIAL', 'GENERAL', 'MAXXIS', 'KLEBER']);

export function brandTier(brand: string): string {
  const b = String(brand || '').trim().toUpperCase();
  if (!b) return 'budget';
  for (const p of PREMIUM) if (b.startsWith(p) || b.includes(p)) return 'premium';
  for (const m of MID) if (b.startsWith(m) || b.includes(m)) return 'mid-range';
  // An unrecognised name is far likelier to be a far-eastern budget marque than an
  // unlisted premium one, and over-promising a tyre is worse than under-promising it.
  return 'budget';
}

/** '235/60 R18', '235/60R18' and '235 60 18' all mean the same thing. The space before
 *  the R is how it reads off a sidewall, and dropping it loses the size. */
export function parseTyreSize(input: string): { width: string; aspect: string; rim: string } | null {
  const m = String(input || '').toUpperCase().match(/(\d{3})\s*\/?\s*(\d{2})\s*R?\s*(\d{2})\b/);
  return m ? { width: m[1], aspect: m[2], rim: m[3] } : null;
}

function slotLabel(date: string, time: string): string {
  try {
    const d = new Date(`${date}T${time}:00`);
    return `${d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })} at ${time}`;
  } catch {
    return `${date} ${time}`;
  }
}

export class TyresoftChatDiary implements ChatDiaryAdapter {
  readonly label = 'Tyresoft';

  readonly capabilities: ChatDiaryCapabilities = {
    bookings: true,
    quotePrices: true,
    // The 3p API has no endpoints for changing a booking.
    retrieveBooking: false,
    reschedule: false,
    cancel: false,
    customerLookup: false,
    vehicleLookup: true,      // vrmLookup, and it carries the tyre sizes
    tyreSales: true,
    basket: true,
    branches: true,           // depots
    advisories: false,
    serviceHistory: false,
    // saveCustomer CARRIES address fields but does not require them: TS-6092 was accepted
    // with all of them empty. Marking this true made the agent demand a house number
    // before it would book, and stall when the customer had not volunteered one.
    needsAddress: false,
    needsEmail: false,
  };

  private readonly cfg: TyresoftConfig;
  private readonly depotId: number;
  private servicesCfg: Array<Record<string, any>>;

  private basket: DiaryBasketLine[] = [];
  private chosen: Array<Record<string, any>> = [];
  private lastTyres: DiaryTyre[] = [];
  private vehicle: Record<string, any> = {};
  private vrm = '';
  private slots: Array<Record<string, any>> = [];
  /** Tyre stock, injected rather than read from disk here so the caller decides whether it
   *  comes from the portal feed or the baked CSV. */
  private inventory: Array<Record<string, any>> = [];

  constructor(config: TyresoftConfig, inventory: Array<Record<string, any>> = []) {
    this.cfg = config || {};
    this.depotId = Number(config?.tsDepotId ?? 1) || 1;
    this.servicesCfg = (config?.tsServices || []) as Array<Record<string, any>>;
    this.inventory = inventory;
  }

  get enabled(): boolean {
    return Boolean(this.cfg.tsWorkspace && this.cfg.tsUsername
      && this.cfg.tsPassword && this.cfg.tsApiKey);
  }

  private get baseUrl(): string {
    return `${API_ROOT}/${this.cfg.tsWorkspace}`;
  }

  private get headers(): Record<string, string> {
    const basic = Buffer.from(`${this.cfg.tsUsername}:${this.cfg.tsPassword}`).toString('base64');
    return {
      Authorization: `Basic ${basic}`,
      'x-api-key': String(this.cfg.tsApiKey || ''),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  private assertEnabled(): void {
    if (!this.enabled) throw new DiaryError('Tyresoft is not configured for this garage');
  }

  async lookupVehicle(registration: string): Promise<DiaryVehicle | null> {
    this.assertEnabled();
    const clean = String(registration || '').replace(/\s+/g, '').toUpperCase();
    try {
      const res = await axios.get(`${this.baseUrl}/vrmLookup/${encodeURIComponent(clean)}`,
                                  { headers: this.headers, timeout: 30000 });
      const d: any = res.data;
      if (!d) return null;
      this.vehicle = d;
      this.vrm = clean;
      const sizes: string[] = [];
      for (const o of (d.tyreSizeOptions || [])) {
        if (o.width && o.profile && o.rim) {
          const label = `${o.width}/${o.profile}R${o.rim}`;
          if (!sizes.includes(label)) sizes.push(label);
        }
      }
      return {
        registration: clean,
        make: String(d.make || ''),
        model: String(d.model || ''),
        description: [d.make, d.model].filter(Boolean).join(' '),
        tyreSizes: sizes,
        raw: d,
      };
    } catch {
      return null;
    }
  }

  /** The catalogue is the garage's portal config, filtered to what suits this vehicle —
   *  engine-size bands and fuel restrictions. Tyresoft has no services endpoint. */
  async offerServices(registration: string): Promise<DiaryService[]> {
    this.assertEnabled();
    const cc = Number(this.vehicle?.engineCapacity || 0) || undefined;
    const fuel = String(this.vehicle?.fuel || '').toLowerCase();

    const applies = (s: Record<string, any>): boolean => {
      const band = s.engineRange || s.engine_range;
      if (band && cc) {
        const [lo, hi] = String(band).split('-').map((n) => parseInt(n, 10));
        if (!Number.isNaN(lo) && !Number.isNaN(hi) && (cc < lo || cc > hi)) return false;
      }
      const restriction = String(s.fuelRestriction || '').toLowerCase();
      if (restriction && fuel && !restriction.includes(fuel)) return false;
      return true;
    };

    return this.servicesCfg.filter(applies).map((s) => ({
      // Two ids live on a configured service: `id` is the short portal label ("MOT"),
      // tsServiceId is the real Tyresoft id the API needs. Key on the real one, or
      // createSale books the wrong thing.
      key: String(s.tsServiceId ?? s.id ?? ''),
      name: String(s.name || '').trim(),
      price: typeof s.price === 'number' ? s.price : undefined,
      raw: s,
    })).filter((s) => s.key);
  }

  async offerSlots(serviceKeys: string[], opts?: { fromDate?: string }): Promise<DiarySlot[]> {
    this.assertEnabled();
    if (serviceKeys?.length) {
      this.chosen = this.servicesCfg.filter(
        (s) => serviceKeys.includes(String(s.tsServiceId ?? s.id ?? '')));
    }

    // A tyre-only job has no service ids, and the endpoint refuses an empty list outright
    // ("Bad Data. Invalid basket selection.", 998). [0] is what it wants for plain fitting.
    const ids = this.chosen.map((s) => s.tsServiceId ?? s.id).filter(Boolean);
    const list = ids.length ? ids : [0];

    // A tyre that takes three days to arrive sets the earliest the whole job can be
    // fitted; offering tomorrow for stock that has not landed is the mistake the customer
    // discovers on the forecourt.
    // Never same-day: the production Tyresoft agent starts from tomorrow, because tyres
    // cannot be ordered, delivered and fitted in the same afternoon. A lead time pushes it
    // out further; it never pulls it back in.
    const lead = Math.max(1, ...this.basket.map((l) => l.leadTimeDays || 0));
    const earliest = new Date();
    earliest.setDate(earliest.getDate() + lead);
    const earliestIso = earliest.toISOString().slice(0, 10);
    let start = opts?.fromDate || earliestIso;
    if (earliestIso > start) start = earliestIso;

    let data: any;
    try {
      // POST, not GET — a GET here is rejected by API Gateway with a SigV4 error that
      // reads like an auth problem and is nothing of the sort.
      const res = await axios.post(
        `${this.baseUrl}/availableSlotsForBasket/${this.depotId}/${encodeURIComponent(start)}`,
        { list }, { headers: this.headers, timeout: 30000 });
      data = res.data;
    } catch (e: any) {
      throw new DiaryError(`could not get availability: ${e?.response?.data?.errorMessage || e.message}`);
    }

    const rows: any[] = Array.isArray(data) ? data : (data?.slots || []);
    this.slots = [];
    const out: DiarySlot[] = [];
    for (const t of rows) {
      // requiredSlots carries the diary metadata createSale insists on; drop it here and
      // the sale is rejected.
      const req = (t.requiredSlots || [{}])[0] || {};
      const date = String(t.date || '');
      const time = String(t.time || '').slice(0, 5);
      if (!date || !time) continue;
      this.slots.push({
        date, time,
        diaryCategoryID: req.diaryCategoryID ?? 1,
        slotTypeID: req.slotTypeID ?? 1,
        estimatedTime: req.estimatedTime ?? 30,
      });
      out.push({ key: `${date}|${time}`, startIso: `${date}T${time}`, label: slotLabel(date, time) });
    }
    return out;
  }

  // ── Tyres ──────────────────────────────────────────────────────────────────
  async searchTyres(size: string, opts: { position?: string; quality?: string; brand?: string }):
    Promise<DiaryTyre[]> {
    this.assertEnabled();
    const parsed = parseTyreSize(size);
    if (!parsed) throw new DiaryError(`could not read a tyre size from "${size}"`);

    let rows = this.inventory.filter((t) =>
      String(t.width) === parsed.width
      && String(t.aspect_ratio ?? t.aspect) === parsed.aspect
      && String(t.rim) === parsed.rim
      && (!opts.brand || String(t.brand || '').toUpperCase().includes(opts.brand.toUpperCase())));
    rows.sort((a, b) => Number(a.price ?? 1e9) - Number(b.price ?? 1e9));

    // Prefer the tier they asked for, cheapest FIRST WITHIN that tier. Sorting the whole
    // list by price and calling the dearest "premium" is how a budget marque got sold as
    // one.
    const wanted = ['budget', 'mid-range', 'premium'].includes(String(opts.quality))
      ? String(opts.quality) : '';
    if (wanted) {
      const inTier = rows.filter((t) => brandTier(String(t.brand || '')) === wanted);
      if (inTier.length) rows = inTier;
    }

    this.lastTyres = rows.slice(0, 6).map((t) => ({
      stockNumber: String(t.stock_number || ''),
      brand: String(t.brand || ''),
      title: String(t.title || ''),
      price: Number(t.price || 0),
      size: `${parsed.width}/${parsed.aspect}R${parsed.rim}`,
      tier: brandTier(String(t.brand || '')),
      leadTimeDays: Number(t.lead_time_days || 0) || 0,
      raw: t,
    }));
    return this.lastTyres;
  }

  async addTyre(tyre: DiaryTyre, quantity: number): Promise<DiaryBasketLine> {
    const qty = Number(quantity) > 0 ? Number(quantity) : 4;
    const existing = this.basket.find((l) => l.kind === 'tyre' && l.ref === tyre.stockNumber);
    if (existing) {
      // SET the quantity, do not add to it. The agent re-states a choice as the conversation
      // moves on ("your two front Pirellis, then") and every restatement was another two
      // tyres on the job: "two front tyres" came out as 4, and 6 once an MOT was added too.
      // Someone genuinely wanting more says so, and the model passes the new total.
      existing.quantity = qty;
      return existing;
    }
    const line: DiaryBasketLine = {
      kind: 'tyre',
      description: `${tyre.brand} ${tyre.title}`.trim(),
      quantity: qty,
      unitPrice: tyre.price,
      ref: tyre.stockNumber,
      leadTimeDays: tyre.leadTimeDays || 0,
    };
    this.basket.push(line);
    return line;
  }

  async addServiceLine(serviceKey: string): Promise<DiaryBasketLine> {
    const svc = this.servicesCfg.find(
      (s) => String(s.tsServiceId ?? s.id) === String(serviceKey));
    if (!svc) throw new DiaryError(`no configured service matches "${serviceKey}"`);
    if (!this.chosen.includes(svc)) this.chosen.push(svc);
    const line: DiaryBasketLine = {
      kind: 'service',
      description: String(svc.name || 'Service'),
      quantity: 1,
      unitPrice: Number(svc.price || 0),
      ref: String(svc.id || ''),
    };
    this.basket.push(line);
    return line;
  }

  basketLines(): DiaryBasketLine[] {
    return [...this.basket];
  }

  clearBasket(): void {
    this.basket = [];
    this.chosen = [];
  }

  async confirm(slotKey: string, contact: DiaryContact): Promise<DiaryBooking> {
    this.assertEnabled();
    const [date, time] = String(slotKey || '').split('|');
    if (!date || !time) throw new DiaryError("slot key must be 'YYYY-MM-DD|HH:MM'");
    const slot = this.slots.find((s) => s.date === date && s.time === time)
      ?? { date, time, diaryCategoryID: 1, slotTypeID: 1, estimatedTime: 30 };

    const parts = String(contact.name || '').trim().split(/\s+/);
    const post = async (path: string, body: unknown) => {
      const res = await axios.post(`${this.baseUrl}/${path}`, body,
                                   { headers: this.headers, timeout: 30000 });
      return res.data as any;
    };

    let customerId = 0;
    let vehicleId = 0;
    try {
      const cust = await post('saveCustomer', {
        customerID: 0, accountNumber: '',
        contactData: {
          name: { salutation: '', firstName: parts[0] || contact.name || '',
                  lastName: parts.slice(1).join(' '), company: '' },
          address: { addressLine1: contact.address || '', addressLine2: '', addressLine3: '',
                     addressLine4: '', city: contact.city || '', county: '',
                     postcode: contact.postcode || '', country: '', longitude: '', latitude: '' },
          contact: { contact: '', mobile: contact.phone || '', email: contact.email || '',
                     telephone: '', twitter: '' },
          sendSMSCorrespondance: false, sendEmailCorrespondance: false,
          sendPostalCorrespondance: false, marketingOptOut: false,
        },
        priceLevelID: 0, creditAccount: false, notes: '',
      });
      customerId = cust?.customerID ?? cust?.id ?? 0;

      const veh = await post('saveVehicle', {
        vehicleID: 0,
        specifications: {
          vrm: this.vrm, make: this.vehicle.make || '', model: this.vehicle.model || '',
          yearOfManufacture: this.vehicle.yearOfManufacture || '',
          colour: this.vehicle.colour || '', mvrisMakeCode: '', mvrisModelCode: '',
          vinSerialNo: this.vehicle.vinSerialNo || '',
          dateFirstRegistered: this.vehicle.dateFirstRegistered || '',
          fuel: this.vehicle.fuel || '', doorplan: this.vehicle.doorplan || '',
          engineNumber: '', co2Emissions: '', gears: '',
          motDue: this.vehicle.motDue || '', taxDue: '', lastVRMLookupDate: '',
          tyreSizeOptions: [],
        },
        tyreSize: { tyreSizeFront: '', speedRatingFront: '', loadIndexFront: '',
                    tyrePressureFront: '', tyreSizeRear: '', speedRatingRear: '',
                    loadIndexRear: '', tyrePressureRear: '' },
        customerID: customerId, motDueDate: '', taxDueDate: '', serviceDueDate: '',
        tyreCheckDate: '', nextInspectionDate: '', authorisedVehicle: false,
        fleetNumber: '', vrmChecked: false,
        flagData: { flagName: '', flagNotes: '' },
      });
      vehicleId = veh?.vehicleID ?? veh?.id ?? 0;
    } catch (e: any) {
      throw new DiaryError(
        `could not save the customer or vehicle: ${e?.response?.data?.errorMessage || e.message}`);
    }

    const items: any[] = [];
    for (const s of this.chosen) {
      items.push({
        saleLineID: 0, productID: 0, tyrecatID: 0, productEANCode: '',
        productManufacturerCode: '', serviceID: Number(s.tsServiceId ?? s.id ?? 0),
        shippingService: false, incomeAccountID: 0, sequence: 0,
        itemCode: '', itemDescription: '', recordedDescription: String(s.name || 'Service'),
        technicianID: 0, quantity: 1, unitCost: Number(s.price || 0),
        unitCostIncludesVAT: false, discount: 0, vatCodeID: 0, backOrderQuantity: 0,
        taggedItemIdentifier: '', linkLineID: 0, hideChildLinks: false,
        groupLinkSellPrices: false, voucherCode: '', voucherCodeLine: false,
        estimatedCost: 0, protectEstimatedCost: false, leadTime: 0, sourceSupplierID: 0,
        sourcePurchaseOrderID: 0, externalOrderLineReference: '',
        changeInQtyAffectingPickList: false, creditedAmount: 0,
      });
    }
    for (const line of this.basket.filter((l) => l.kind === 'tyre')) {
      items.push({
        saleLineID: 0, productID: 0, tyrecatID: 0, productEANCode: '',
        productManufacturerCode: '', serviceID: 0, shippingService: false,
        incomeAccountID: 0, sequence: 0, productItem: true, itemCode: line.ref,
        itemDescription: '', recordedDescription: line.description, technicianID: 0,
        quantity: line.quantity, unitCost: line.unitPrice, unitCostIncludesVAT: false,
        discount: 0, vatCodeID: 0, backOrderQuantity: 0, taggedItemIdentifier: '',
        linkLineID: 0, hideChildLinks: false, groupLinkSellPrices: false, voucherCode: '',
        voucherCodeLine: false, estimatedCost: 0, protectEstimatedCost: false, leadTime: 0,
        sourceSupplierID: 0, sourcePurchaseOrderID: 0, externalOrderLineReference: '',
        changeInQtyAffectingPickList: false, creditedAmount: 0,
      });
    }
    if (items.length === 0) {
      throw new DiaryError('nothing to book — the job has no tyres and no services');
    }

    let sale: any;
    try {
      sale = await post('createSale', {
        // channelID is PER WORKSPACE — another workspace's id comes back as
        // "Invalid client channel id".
        depotID: this.depotId, saleDate: date, saleStatus: 'Order',
        notes: contact.notes || 'Booking created via ReceptionMate chat',
        worksheetNumber: '', salesAdvisorID: 0, poNumber: `RM-${Date.now()}`,
        flag: 1, flagNotes: 'ReceptionMate Booking', advertisingSurvey: '',
        customerID: customerId,
        currencyUnit: { currencyCode: '', conversionRate: 0 },
        vehicleID: vehicleId,
        vehicleMileage: Number(contact.mileage) || 0,
        channelID: Number(this.cfg.tsChannelId ?? 24) || 24,
        orderStatus: 'Awaiting Acknowledgement', externalOrderReference: '',
        channelBuyer: '', overrideInvoiceNumber: '', deliveryAddressID: 0,
        deliveryType: 'NONE', sourceShippingOverride: '', fittingCentreID: 0,
        deliverToFittingCentre: false, workSummary: '', advisoryNotes: '',
        bookingSlot: { date: slot.date, time: slot.time,
                       diaryCategoryID: slot.diaryCategoryID,
                       estimatedTime: slot.estimatedTime, slotTypeID: slot.slotTypeID },
        items,
        holdUntilDate: '', authorisePayment: '',
        payments: [{ paymentMethodID: 0, paymentAmount: 0, paymentDate: '',
                     paymentReference: '', externalReference: '', leaveUnallocated: true,
                     depotID: 0, overrideDepositAccountID: 0, customerID: 0 }],
        customGroupID: 0, customValues: [], vatOverrideAmount: 0,
        grossTotalForVATOverride: 0, gsQuoteJobNumber: 0, collectionSourceSaleLineID: 0,
      });
    } catch (e: any) {
      throw new DiaryError(
        `the booking was not accepted: ${e?.response?.data?.errorMessage || e.message}`);
    }

    const num = sale?.saleNumber;
    if (!num) throw new DiaryError('the sale did not come back with a number');

    const described = [
      ...this.chosen.map((s) => String(s.name || '')),
      ...this.basket.filter((l) => l.kind === 'tyre').map((l) => `${l.quantity} x ${l.description}`),
    ].filter(Boolean);
    return {
      reference: `TS-${num}`,
      whenIso: `${date}T${time}`,
      serviceName: described.join(', '),
      raw: sale,
    };
  }

  flowPrompt(): string {
    return [
      'THIS GARAGE SELLS TYRES AND BOOKS GARAGE WORK. Both go on the same job — someone ',
      'can have two front tyres and an MOT on one visit.',
      '',
      'TYRES:',
      '1. Get the registration, then look the vehicle up — it returns the tyre SIZES ON ',
      '   RECORD. Read the size back and ask if it is right rather than asking them to ',
      '   read their sidewall. Only ask for the size if the lookup returns none.',
      '2. Take the position from what they already said — "two front tyres" gives both the ',
      '   quantity and the position. Only ask if they have not said.',
      '3. ALWAYS ask which quality they want — budget, mid-range or premium — before ',
      '   searching. The tier decides what they are shown at all, so never pick it for them.',
      '4. Offer two or three by brand and price, cheapest first, exactly as returned.',
      '5. Add the one they choose, then ask ONCE if they need anything else on the same ',
      '   visit. Tyres on their own are a complete job: if they say no, or just ask you to ',
      '   book it, go straight to availability. Never hold a tyre booking back waiting for ',
      '   a service they have not asked for.',
      '',
      'SERVICES AND REPAIRS go on the SAME job — MOT, servicing, brakes, air con, ',
      'alignment, punctures. Pass every service they asked for together.',
      '',
      'BOOKING: get availability for the whole job FIRST, then offer one or two real times. ',
      'Never ask which day suits before you have times to offer — you cannot act on the ',
      'answer, and asking again is how the conversation stalls. Then collect their details, ',
      'read the whole job back — every tyre and every service — and confirm. Say "booked" ',
      'only after it succeeds.',
    ].join('\n');
  }

  promptFragment(): string {
    return [
      "THIS GARAGE'S DIARY (Tyresoft):",
      '- You cannot move or cancel an existing booking here — take a message for those.',
      '- Nothing in stock in the size they need? Say so plainly and offer a callback. ',
      '  Never substitute another size as though it were what they asked for.',
      '- A tyre with a lead time sets the earliest the whole job can be fitted.',
    ].join('\n');
  }
}
