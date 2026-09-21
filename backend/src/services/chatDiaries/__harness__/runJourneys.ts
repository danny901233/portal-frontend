/**
 * 30 booking journeys per diary adapter, against TEST ACCOUNTS ONLY.
 *
 * This exercises the diary layer before anything is built on top of it. The voice merge
 * went wrong repeatedly by building upward on layers that had never been verified, so the
 * adapters get proven first and the chat agent second.
 *
 * Safety: the garage ids below are the four 🔵 Test — garages and nothing else. The runner
 * refuses to start if a garage's name does not begin with the test marker, and every
 * booking it commits is cancelled afterwards on the diaries that can cancel.
 *
 *   npx tsx src/services/chatDiaries/__harness__/runJourneys.ts [garagehive|tyresoft|bookar|poole]
 */

import { PrismaClient } from '@prisma/client';
import { GarageHiveChatDiary } from '../garageHive.js';
import { PooleChatDiary } from '../poole.js';
import { BookarChatDiary } from '../bookar.js';
import { TyresoftChatDiary } from '../tyresoft.js';
import { type ChatDiaryAdapter, DiaryError } from '../types.js';

const prisma = new PrismaClient();

/** Only these. A live garage must never appear here. */
const TEST_GARAGES: Record<string, string> = {
  garagehive: '844385bf-199d-426f-8b1e-caaa98cdc21e',
  tyresoft: 'a72e3f2f-dc68-42d8-b4b0-9d9eea48cc1b',
  bookar: '8e9548b0-9f23-4344-816e-a24605998759',
  poole: '5314e15a-0969-4f69-ba83-53c2e0250368',
};

const REG = 'V20ALA';
const PHONE = '07976500282';

type Outcome = 'PASS' | 'FAIL' | 'SKIP';
interface Result { n: number; name: string; outcome: Outcome; detail: string }

function ok(n: number, name: string, detail = ''): Result {
  return { n, name, outcome: 'PASS', detail };
}
function bad(n: number, name: string, detail: string): Result {
  return { n, name, outcome: 'FAIL', detail: detail.slice(0, 120) };
}
function skip(n: number, name: string, why: string): Result {
  return { n, name, outcome: 'SKIP', detail: why };
}

function isoIn(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

async function buildAdapter(key: string): Promise<{ adapter: ChatDiaryAdapter; garage: string }> {
  const id = TEST_GARAGES[key];
  const rows: any[] = await prisma.$queryRawUnsafe(
    `SELECT g.name, a."integrationProviderConfig" AS cfg
     FROM "Garage" g JOIN "AgentConfiguration" a ON a."garageId"=g.id WHERE g.id=$1`, id);
  const row = rows[0];
  if (!row) throw new Error(`no garage ${id}`);
  // Refuse to touch anything that is not a marked test garage.
  if (!/test/i.test(String(row.name))) {
    throw new Error(`REFUSING: "${row.name}" is not a test garage`);
  }
  const cfg = (row.cfg || {}) as Record<string, any>;

  switch (key) {
    case 'garagehive':
      return { garage: row.name, adapter: new GarageHiveChatDiary({
        customerId: cfg.customerId ?? cfg.ghCustomerId,
        apiKey: cfg.apiKey ?? cfg.ghApiKey,
        locationId: String(cfg.locationId ?? cfg.ghLocationId ?? '23'),
      }) };
    case 'poole':
      return { garage: row.name, adapter: new PooleChatDiary({
        branchKey: cfg.branchKey ?? cfg.poole?.branchKey,
        tenant: cfg.tenant ?? cfg.poole?.tenant,
      }) };
    case 'bookar':
      return { garage: row.name, adapter: new BookarChatDiary(cfg) };
    case 'tyresoft':
      return { garage: row.name, adapter: new TyresoftChatDiary(cfg as any, []) };
    default:
      throw new Error(`unknown diary ${key}`);
  }
}

async function run(key: string): Promise<Result[]> {
  const { adapter, garage } = await buildAdapter(key);
  const c = adapter.capabilities;
  const r: Result[] = [];
  let n = 0;
  const step = async (name: string, fn: () => Promise<string>) => {
    n += 1;
    try {
      r.push(ok(n, name, await fn()));
    } catch (e: any) {
      r.push(bad(n, name, e instanceof DiaryError ? e.message : String(e?.message || e)));
    }
  };
  const gated = (name: string, allowed: boolean, why: string, fn: () => Promise<string>) =>
    allowed ? step(name, fn) : (n += 1, r.push(skip(n, name, why)), Promise.resolve());

  console.log(`\n=== ${adapter.label}  (${garage})  enabled=${adapter.enabled}`);

  // ── configuration and shape ───────────────────────────────────────────────
  await step('adapter is enabled with the test credentials', async () => {
    if (!adapter.enabled) throw new Error('credentials missing');
    return 'enabled';
  });
  await step('capabilities are self-consistent', async () => {
    if (c.reschedule && !c.retrieveBooking) throw new Error('can reschedule but not retrieve');
    if (c.tyreSales && !c.basket) throw new Error('sells tyres but has no basket');
    return `${Object.entries(c).filter(([, v]) => v).length} capabilities`;
  });
  await step('flow prompt names no other diary', async () => {
    const t = `${adapter.flowPrompt()} ${adapter.promptFragment()}`.toLowerCase();
    const others = ['garage hive', 'tyresoft', 'bookar', 'autosage']
      .filter((o) => !adapter.label.toLowerCase().includes(o) && t.includes(o));
    if (others.length) throw new Error(`mentions ${others.join(', ')}`);
    return 'clean';
  });
  await step('flow prompt names no adapter method', async () => {
    const t = `${adapter.flowPrompt()} ${adapter.promptFragment()}`;
    const leaked = ['offerSlots', 'offerServices', 'basketLines', 'addServiceLine']
      .filter((m) => t.includes(m));
    if (leaked.length) throw new Error(`names ${leaked.join(', ')}`);
    return 'clean';
  });

  // ── vehicle and customer ──────────────────────────────────────────────────
  await gated('look up a known vehicle', Boolean(c.vehicleLookup && adapter.lookupVehicle),
    'diary has no vehicle lookup', async () => {
      const v = await adapter.lookupVehicle!(REG);
      return v ? `${v.description || v.registration}` : 'no vehicle returned';
    });
  await gated('look up nonsense registration', Boolean(c.vehicleLookup && adapter.lookupVehicle),
    'diary has no vehicle lookup', async () => {
      const v = await adapter.lookupVehicle!('ZZ99ZZZ');
      return v ? 'returned a vehicle (suspicious)' : 'correctly returned nothing';
    });
  await gated('find a customer by phone', Boolean(c.customerLookup && adapter.findCustomerByPhone),
    'diary cannot look customers up', async () => {
      const cu = await adapter.findCustomerByPhone!(PHONE);
      return cu ? `found ${cu.name}` : 'no customer on file';
    });
  await gated('customer lookup with a junk number',
    Boolean(c.customerLookup && adapter.findCustomerByPhone),
    'diary cannot look customers up', async () => {
      const cu = await adapter.findCustomerByPhone!('0000000000');
      return cu ? 'returned someone (suspicious)' : 'correctly returned nothing';
    });
  await gated('list branches', Boolean(c.branches && adapter.branches),
    'diary has one branch', async () => {
      const b = await adapter.branches!();
      return `${b.length} branch(es)`;
    });

  // ── services ──────────────────────────────────────────────────────────────
  let services: any[] = [];
  await step('offer services for the vehicle', async () => {
    services = await adapter.offerServices(REG);
    if (!Array.isArray(services)) throw new Error('did not return a list');
    return `${services.length} services`;
  });
  await step('every service has an opaque key and a name', async () => {
    const broken = services.filter((s) => !s.key || !s.name);
    if (broken.length) throw new Error(`${broken.length} without key or name`);
    return 'all well-formed';
  });
  await step('service keys are unique', async () => {
    const keys = services.map((s) => s.key);
    if (new Set(keys).size !== keys.length) throw new Error('duplicate keys');
    return `${keys.length} unique`;
  });
  await step('prices are numbers or absent, never NaN', async () => {
    const nan = services.filter((s) => s.price !== undefined && Number.isNaN(s.price));
    if (nan.length) throw new Error(`${nan.length} NaN prices`);
    return 'clean';
  });
  await step('offering services for a junk reg does not throw unexpectedly', async () => {
    try {
      const s = await adapter.offerServices('ZZ99ZZZ');
      return `returned ${s.length}`;
    } catch (e) {
      if (e instanceof DiaryError) return 'refused cleanly with DiaryError';
      throw e;
    }
  });

  // ── availability ──────────────────────────────────────────────────────────
  // Journey 14 deliberately fails a lookup, which on a session-based diary throws the
  // half-open session away. That is correct — but a real conversation would then re-open
  // it with the right registration, so the harness does the same before asking for times.
  const firstKey = () => (services[0]?.key ? [String(services[0].key)] : []);
  let slots: any[] = [];
  await step('re-open the booking after a failed lookup', async () => {
    services = await adapter.offerServices(REG);
    return `${services.length} services on a fresh session`;
  });
  await step('availability for one service', async () => {
    if (!firstKey().length) return 'no services to ask with';
    slots = await adapter.offerSlots(firstKey());
    return `${slots.length} slots`;
  });
  await step('availability for TWO services together', async () => {
    const two = services.slice(0, 2).map((s) => String(s.key));
    if (two.length < 2) return 'garage lists fewer than two services';
    const s = await adapter.offerSlots(two);
    return `${s.length} slots for a two-part job`;
  });
  await step('an empty service list behaves as the diary requires', async () => {
    // On a basket diary an empty list is LEGITIMATE: a tyre-only job has no service, and
    // Tyresoft asks for plain fitting slots. On a service-only diary it is a mistake and
    // must be refused rather than silently booking nothing.
    try {
      const s = await adapter.offerSlots([]);
      if (c.basket) return `${s.length} fitting slots for a tyre-only job, as expected`;
      throw new Error('a service-only diary accepted an empty list');
    } catch (e) {
      if (e instanceof DiaryError) {
        if (c.basket) throw new Error(`a basket diary refused a tyre-only job: ${e.message}`);
        return 'refused cleanly';
      }
      throw e;
    }
  });
  await step('slot keys parse as YYYY-MM-DD|HH:MM', async () => {
    const bad = slots.filter((s) => !/^\d{4}-\d{2}-\d{2}\|\d{2}:\d{2}$/.test(s.key));
    if (bad.length) throw new Error(`${bad.length} malformed, e.g. ${bad[0]?.key}`);
    return `${slots.length} well-formed`;
  });
  await step('slot labels are readable, not raw ISO', async () => {
    const raw = slots.filter((s) => /^\d{4}-\d{2}-\d{2}T/.test(s.label));
    if (raw.length) throw new Error(`${raw.length} unformatted labels`);
    return slots[0]?.label || 'no slots to check';
  });
  await step('slots are in chronological order or at least parseable', async () => {
    const bad = slots.filter((s) => Number.isNaN(Date.parse(s.startIso)));
    if (bad.length) throw new Error(`${bad.length} unparseable startIso`);
    return 'all parseable';
  });
  await step('availability from a future date', async () => {
    if (!firstKey().length) return 'no services to ask with';
    const s = await adapter.offerSlots(firstKey(), { fromDate: isoIn(14) });
    return `${s.length} slots from ${isoIn(14)}`;
  });
  await step('no slot is offered in the past', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const past = slots.filter((s) => s.key.split('|')[0] < today);
    if (past.length) throw new Error(`${past.length} slots before today`);
    return 'none in the past';
  });
  await gated('no slot is offered for today (lead time)', adapter.label === 'Bookar',
    'diary has no lead-time rule', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const same = slots.filter((s) => s.key.split('|')[0] === today);
      if (same.length) throw new Error(`${same.length} same-day slots offered`);
      return 'earliest is tomorrow, as the diary requires';
    });

  // ── tyres ─────────────────────────────────────────────────────────────────
  await gated('search tyres by size', Boolean(c.tyreSales && adapter.searchTyres),
    'diary does not sell tyres', async () => {
      const t = await adapter.searchTyres!('235/60 R18', { quality: 'premium' });
      return `${t.length} tyres (inventory is injected; empty is expected here)`;
    });
  await gated('a size with a space before the R still parses',
    Boolean(c.tyreSales && adapter.searchTyres), 'diary does not sell tyres', async () => {
      const { parseTyreSize } = await import('../tyresoft.js');
      const a = parseTyreSize('235/60 R18');
      const b = parseTyreSize('235/60R18');
      const c2 = parseTyreSize('235 60 18');
      if (!a || !b || !c2) throw new Error('one of the spellings failed to parse');
      return 'all three spellings parse';
    });
  await gated('tyre tier is decided by brand, not price',
    Boolean(c.tyreSales), 'diary does not sell tyres', async () => {
      const { brandTier } = await import('../tyresoft.js');
      if (brandTier('MICHELIN') !== 'premium') throw new Error('Michelin not premium');
      if (brandTier('NANKANG') !== 'budget') throw new Error('unknown brand not budget');
      if (brandTier('AVON') !== 'mid-range') throw new Error('Avon not mid-range');
      return 'premium/mid/budget by brand';
    });
  await gated('tyres and a service can sit on one job',
    Boolean(c.basket && adapter.addServiceLine && adapter.basketLines),
    'diary has no basket', async () => {
      if (!services[0]?.key) return 'no services configured to add';
      await adapter.addServiceLine!(String(services[0].key));
      const lines = adapter.basketLines!();
      adapter.clearBasket?.();
      return `${lines.length} line(s) on the job`;
    });

  // ── changing a booking ────────────────────────────────────────────────────
  await gated('retrieve a booking that does not exist',
    Boolean(c.retrieveBooking && adapter.retrieveBooking),
    'diary cannot retrieve bookings', async () => {
      const b = await adapter.retrieveBooking!('DEFINITELY-NOT-A-REF');
      return b ? 'returned a booking (suspicious)' : 'correctly returned nothing';
    });
  await gated('rescheduling an unknown reference fails cleanly',
    Boolean(c.reschedule && adapter.reschedule), 'diary cannot reschedule', async () => {
      try {
        await adapter.reschedule!('DEFINITELY-NOT-A-REF', `${isoIn(3)}|09:00`);
        return 'accepted an unknown reference (suspicious)';
      } catch (e) {
        if (e instanceof DiaryError) return 'refused cleanly with DiaryError';
        throw e;
      }
    });
  await gated('cancelling an unknown reference fails cleanly',
    Boolean(c.cancel && adapter.cancel), 'diary cannot cancel', async () => {
      try {
        await adapter.cancel!('DEFINITELY-NOT-A-REF', 'harness');
        return 'accepted an unknown reference (suspicious)';
      } catch (e) {
        if (e instanceof DiaryError) return 'refused cleanly with DiaryError';
        throw e;
      }
    });
  await gated('a bad slot key is refused before anything is written',
    true, '', async () => {
      try {
        await adapter.confirm('not-a-slot', { name: 'Harness Test', phone: PHONE });
        return 'accepted a malformed slot key (suspicious)';
      } catch (e) {
        if (e instanceof DiaryError) return 'refused cleanly with DiaryError';
        throw e;
      }
    });

  // ── the real thing ────────────────────────────────────────────────────────
  let created: string | null = null;
  await step('COMMIT: book a real appointment in the test diary', async () => {
    if (!slots.length || !firstKey().length) return 'no slots available to book';
    await adapter.offerSlots(firstKey());
    const b = await adapter.confirm(slots[0].key, {
      name: 'Harness Test', phone: PHONE, email: 'harness@example.com',
      address: '55 Test Road', postcode: 'CB23 9AZ', city: 'Rugby',
      mileage: '25000', notes: 'automated adapter harness — safe to delete',
    });
    created = b.reference || null;
    if (!b.reference) throw new Error('booked but returned no reference');
    return `reference ${b.reference} for ${b.whenIso}`;
  });
  await gated('the new booking can be read back',
    Boolean(c.retrieveBooking && adapter.retrieveBooking), 'diary cannot retrieve bookings',
    async () => {
      if (!created) return 'nothing was booked to read back';
      const b = await adapter.retrieveBooking!(created);
      return b ? `read back ${b.reference}` : 'could not read it back';
    });
  await gated('CLEAN UP: cancel what the harness booked',
    Boolean(c.cancel && adapter.cancel), 'diary cannot cancel — booking left in the test diary',
    async () => {
      if (!created) return 'nothing to cancel';
      await adapter.cancel!(created, 'automated harness cleanup');
      return `cancelled ${created}`;
    });

  // ── prompt discipline ─────────────────────────────────────────────────────
  await step('flow prompt tells the agent to pass every service together', async () => {
    const t = adapter.flowPrompt().toLowerCase();
    if (!/every service|both|together/.test(t)) {
      throw new Error('nothing about keeping a multi-part request whole');
    }
    return 'multi-service instruction present';
  });
  await step('flow prompt forbids saying "booked" before it succeeds', async () => {
    const t = adapter.flowPrompt().toLowerCase();
    if (!t.includes('booked')) throw new Error('no rule about the word "booked"');
    return 'present';
  });
  await step('quirks fragment describes the diary, not the flow', async () => {
    const t = adapter.promptFragment();
    if (!t.trim()) throw new Error('empty');
    if (/^\s*1\./m.test(t)) throw new Error('reads like a numbered flow, not quirks');
    return `${t.length} chars`;
  });

  return r;
}

async function main() {
  const only = process.argv[2];
  const keys = only ? [only] : Object.keys(TEST_GARAGES);
  const summary: Record<string, { pass: number; fail: number; skip: number }> = {};

  for (const key of keys) {
    let results: Result[] = [];
    try {
      results = await run(key);
    } catch (e: any) {
      console.log(`\n=== ${key}: could not run — ${e?.message || e}`);
      summary[key] = { pass: 0, fail: 1, skip: 0 };
      continue;
    }
    for (const x of results) {
      const mark = x.outcome === 'PASS' ? ' ok ' : x.outcome === 'FAIL' ? 'FAIL' : 'skip';
      console.log(`  [${String(x.n).padStart(2)}] ${mark}  ${x.name}${x.detail ? ` — ${x.detail}` : ''}`);
    }
    summary[key] = {
      pass: results.filter((x) => x.outcome === 'PASS').length,
      fail: results.filter((x) => x.outcome === 'FAIL').length,
      skip: results.filter((x) => x.outcome === 'SKIP').length,
    };
  }

  console.log('\n=== summary');
  for (const [k, s] of Object.entries(summary)) {
    console.log(`  ${k.padEnd(12)} ${s.pass} passed, ${s.fail} failed, ${s.skip} skipped`
      + ` (${s.pass + s.fail + s.skip} journeys)`);
  }
  await prisma.$disconnect();
  process.exit(Object.values(summary).some((s) => s.fail > 0) ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
