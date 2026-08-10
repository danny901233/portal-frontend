/**
 * Shape tests for pooleApi.ts — verifies each helper calls the right URL +
 * method + headers WITHOUT hitting the real Poole sandbox.
 *
 * The Poole sandbox goes live Fri 7 Aug 2026; until then this file is a
 * shape guarantee only (no network I/O). It's written framework-agnostic:
 * the assertions are plain `throw` statements, so it can run under vitest,
 * jest, tsx (as a script) or `node --test` with minimal wiring.
 *
 * To run under tsx directly (once the project adds a test framework, wire
 * this into the runner):
 *   npx tsx backend/tests/pooleApi.test.ts
 */
import axios from 'axios';
import * as poole from '../src/services/pooleApi.js';

// ── Tiny in-file "framework" (no vitest/jest dependency yet) ─────────────
type CapturedRequest = {
  baseURL?: string;
  method?: string;
  url?: string;
  params?: Record<string, unknown>;
  data?: unknown;
  headers?: Record<string, unknown>;
};

interface FakeAxiosResponse {
  status: number;
  data: unknown;
  headers?: Record<string, string>;
}

const results: Array<{ name: string; ok: boolean; error?: string }> = [];

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
    // eslint-disable-next-line no-console
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    results.push({ name, ok: false, error: err?.message ?? String(err) });
    // eslint-disable-next-line no-console
    console.error(`  ✗ ${name} — ${err?.message ?? err}`);
  }
}

function assertEq<T>(actual: T, expected: T, label: string) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertContains(url: string | undefined, substring: string) {
  if (!url || !url.includes(substring)) {
    throw new Error(`URL "${url}" did not contain "${substring}"`);
  }
}

// Stub axios.create so we intercept the per-instance requests.
function stubAxios(response: FakeAxiosResponse): { captured: CapturedRequest[] } {
  const captured: CapturedRequest[] = [];
  const originalCreate = axios.create;
  (axios as any).create = (opts: any) => {
    const instance: any = {
      request: async (cfg: any) => {
        captured.push({
          baseURL: opts?.baseURL,
          method: cfg.method,
          url: cfg.url,
          params: cfg.params,
          data: cfg.data,
          headers: opts?.headers,
        });
        return { status: response.status, data: response.data, headers: response.headers ?? {} };
      },
    };
    return instance;
  };
  return {
    captured,
    // Reset shim after the test batch completes so we don't leak.
    // (callers restore via `restoreAxios` below at the end of main().)
    ...({} as never),
  };
}

function restoreAxios() {
  // Reset by re-importing the original create function via require would be
  // messier — instead we lean on axios's own module-level create being writable
  // and restore it here after all tests complete.
  // Tests run in a single process; leaving the stub is fine post-run.
}

// ── Tests ────────────────────────────────────────────────────────────────
const BRANCH_KEY = 'test-key-abc';
const BRANCH_CODE = 'RST001';
const REF = '829f66db-4305-43c7-b770-acae570dc200';

async function main() {
  // eslint-disable-next-line no-console
  console.log('pooleApi shape tests');

  await test('findCustomerByPhone — GET /inbound/customers?phone=…', async () => {
    const { captured } = stubAxios({ status: 200, data: [] });
    await poole.findCustomerByPhone(BRANCH_KEY, '07814600320');
    assertEq(captured[0]?.method, 'GET', 'method');
    assertEq(captured[0]?.url, '/inbound/customers', 'path');
    assertEq((captured[0]?.params as any)?.phone, '07814600320', 'phone param');
    assertEq((captured[0]?.headers as any)?.Key, BRANCH_KEY, 'Key header');
  });

  await test('lookupVehicleByVrm — GET /inbound/vehicles/{reg}', async () => {
    const { captured } = stubAxios({
      status: 200,
      data: { registration: 'WF73UYP', make: 'VOLVO', model: 'XC40', mileage: 21500 },
    });
    await poole.lookupVehicleByVrm(BRANCH_KEY, 'wf73 uyp');
    assertEq(captured[0]?.method, 'GET', 'method');
    // Reg should be uppercased + spaces stripped
    assertContains(captured[0]?.url, '/inbound/vehicles/WF73UYP');
  });

  await test('lookupVehicleByVrm returns null on 404', async () => {
    stubAxios({ status: 404, data: { error: 'not found' } });
    const result = await poole.lookupVehicleByVrm(BRANCH_KEY, 'AAAA');
    assertEq(result, null, 'null on 404');
  });

  await test('createDraftBooking — POST /inbound/bookings with callReference dedupe key', async () => {
    const { captured } = stubAxios({ status: 201, data: { bookingRef: REF } });
    await poole.createDraftBooking(BRANCH_KEY, 'call-1234', BRANCH_CODE, 'slow puncture');
    assertEq(captured[0]?.method, 'POST', 'method');
    assertEq(captured[0]?.url, '/inbound/bookings', 'path');
    const body = JSON.parse(String(captured[0]?.data));
    assertEq(body.callReference, 'call-1234', 'callReference');
    assertEq(body.branchCode, BRANCH_CODE, 'branchCode');
    assertEq(body.notes, 'slow puncture', 'notes');
  });

  await test('listServices — GET /inbound/bookings/{ref}/services', async () => {
    const { captured } = stubAxios({ status: 200, data: [] });
    await poole.listServices(BRANCH_KEY, REF);
    assertEq(captured[0]?.method, 'GET', 'method');
    assertContains(captured[0]?.url, `/inbound/bookings/${REF}/services`);
  });

  await test('addServicesToBooking — POST /inbound/bookings/{ref}/services with serviceIds', async () => {
    const { captured } = stubAxios({ status: 202, data: undefined });
    await poole.addServicesToBooking(BRANCH_KEY, REF, [157974]);
    assertEq(captured[0]?.method, 'POST', 'method');
    assertContains(captured[0]?.url, `/inbound/bookings/${REF}/services`);
    const body = JSON.parse(String(captured[0]?.data));
    if (!Array.isArray(body.serviceIds) || body.serviceIds[0] !== 157974) {
      throw new Error(`serviceIds body wrong: ${JSON.stringify(body)}`);
    }
  });

  await test('listAvailableSlots — GET /inbound/bookings/{ref}/slots with date range', async () => {
    const { captured } = stubAxios({ status: 200, data: [] });
    await poole.listAvailableSlots(BRANCH_KEY, REF, '2026-08-10', '2026-08-14');
    assertEq(captured[0]?.method, 'GET', 'method');
    assertContains(captured[0]?.url, `/inbound/bookings/${REF}/slots`);
    assertEq((captured[0]?.params as any)?.startDate, '2026-08-10', 'startDate param');
    assertEq((captured[0]?.params as any)?.endDate, '2026-08-14', 'endDate param');
  });

  await test('reserveSlot — PUT /inbound/bookings/{ref}/slot with {date, time}', async () => {
    const { captured } = stubAxios({ status: 200, data: undefined });
    await poole.reserveSlot(BRANCH_KEY, REF, '2026-08-11', '10:00');
    assertEq(captured[0]?.method, 'PUT', 'method');
    assertContains(captured[0]?.url, `/inbound/bookings/${REF}/slot`);
    const body = JSON.parse(String(captured[0]?.data));
    assertEq(body.date, '2026-08-11', 'date');
    assertEq(body.time, '10:00', 'time');
  });

  await test('confirmBooking — POST /inbound/bookings/{ref}/confirm with customer + vehicle + mileage', async () => {
    const { captured } = stubAxios({
      status: 200,
      data: {
        bookingRef: REF,
        reference: 2795,
        status: 'Booked',
      },
    });
    await poole.confirmBooking(
      BRANCH_KEY,
      REF,
      { firstName: 'Andrei', lastName: 'Bazanov', mobile: '07814600320' },
      { registration: 'wf73uyp', make: 'VOLVO', model: 'XC40' },
      21500,
    );
    assertEq(captured[0]?.method, 'POST', 'method');
    assertContains(captured[0]?.url, `/inbound/bookings/${REF}/confirm`);
    const body = JSON.parse(String(captured[0]?.data));
    assertEq(body.customer.lastName, 'Bazanov', 'customer.lastName');
    assertEq(body.vehicle.registration, 'WF73UYP', 'vehicle.registration is upper+trimmed');
    assertEq(body.mileage, 21500, 'mileage');
  });

  await test('rescheduleBooking — PUT /inbound/bookings/{ref}/reschedule', async () => {
    const { captured } = stubAxios({ status: 200, data: undefined });
    await poole.rescheduleBooking(BRANCH_KEY, REF, '2026-08-12', '11:30');
    assertEq(captured[0]?.method, 'PUT', 'method');
    assertContains(captured[0]?.url, `/inbound/bookings/${REF}/reschedule`);
    const body = JSON.parse(String(captured[0]?.data));
    assertEq(body.date, '2026-08-12', 'date');
    assertEq(body.time, '11:30', 'time');
  });

  await test('cancelBooking — PUT /inbound/bookings/{ref}/cancel with reason', async () => {
    const { captured } = stubAxios({ status: 200, data: undefined });
    await poole.cancelBooking(BRANCH_KEY, REF, 'customer request');
    assertEq(captured[0]?.method, 'PUT', 'method');
    assertContains(captured[0]?.url, `/inbound/bookings/${REF}/cancel`);
    const body = JSON.parse(String(captured[0]?.data));
    assertEq(body.reason, 'customer request', 'reason');
  });

  await test('getBooking — GET /inbound/bookings/{ref}', async () => {
    const { captured } = stubAxios({
      status: 200,
      data: { bookingRef: REF, reference: 2795, status: 'Booked' },
    });
    await poole.getBooking(BRANCH_KEY, REF);
    assertEq(captured[0]?.method, 'GET', 'method');
    assertContains(captured[0]?.url, `/inbound/bookings/${REF}`);
  });

  await test('getBranches — GET /inbound/branches', async () => {
    const { captured } = stubAxios({ status: 200, data: [] });
    await poole.getBranches(BRANCH_KEY);
    assertEq(captured[0]?.method, 'GET', 'method');
    assertEq(captured[0]?.url, '/inbound/branches', 'path');
  });

  await test('401 surfaces PooleAuthError', async () => {
    stubAxios({ status: 401, data: { error: 'bad key' } });
    let caught: unknown;
    try {
      await poole.getBranches('bad');
    } catch (e) {
      caught = e;
    }
    if (!(caught instanceof poole.PooleAuthError)) {
      throw new Error(`expected PooleAuthError, got ${caught}`);
    }
  });

  await test('429 surfaces PooleError with retryAfterSeconds', async () => {
    stubAxios({ status: 429, data: { error: 'slow down' }, headers: { 'retry-after': '30' } });
    let caught: any;
    try {
      await poole.getBranches(BRANCH_KEY);
    } catch (e) {
      caught = e;
    }
    if (!(caught instanceof poole.PooleError)) {
      throw new Error(`expected PooleError, got ${caught}`);
    }
    assertEq(caught.status, 429, 'status');
    assertEq(caught.retryAfterSeconds, 30, 'retryAfterSeconds');
  });

  restoreAxios();

  const failed = results.filter((r) => !r.ok);
  // eslint-disable-next-line no-console
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) {
    // eslint-disable-next-line no-console
    console.error('FAILED:', failed);
    process.exit(1);
  }
}

// Only run when invoked directly (so importing this file for framework
// pickup doesn't kick off the runner twice).
const invokedDirectly = (() => {
  try {
    // ESM-safe self-detect: fileURLToPath of import.meta.url === argv[1]
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — import.meta only exists in ESM builds; guard for safety
    const metaUrl: string | undefined = (import.meta as any)?.url;
    if (!metaUrl) return false;
    const argv1 = process.argv[1] || '';
    return metaUrl.endsWith(argv1.replace(/\\/g, '/')) || argv1.endsWith('pooleApi.test.ts');
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  void main();
}

export { main };
