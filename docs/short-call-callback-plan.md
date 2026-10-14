# Short-call callback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a call to an opted-in garage ends under 30 seconds, the unified agent rings the caller back, introduces itself and tries to help; a callback that works lands in the call logs like any other call, and one that fails leaves nothing garage-facing.

**Architecture:** The agent reports a short call to the portal and makes no decision. A pure policy function decides whether to dial, a sweep dials 60 seconds later over the existing LiveKit SIP outbound trunk with the garage's caller ID, and the agent recognises the callback from its dispatch metadata and swaps its greeting. The loop guard — a callback must never trigger another callback — is enforced twice in code.

**Tech Stack:** TypeScript/Express/Prisma backend, `node:test` via `tsx`; Next.js portal UI; Python LiveKit agent, pytest; `livekit-server-sdk` 2.19.1.

**Spec:** [docs/short-call-callback.md](short-call-callback.md)

## Global Constraints

- **Unified agent only.** `receptionmate-agents/unified-agent`. The other six agent flavours are not touched.
- **Greeting copy, exactly:** `Hi, it's {PERSONA_NAME} for {BRANCH_NAME}. We've just missed a call from you — how can I help?`
- **Greeting is spoken via `session.say` direct to TTS, never routed through the LLM.** Routing a greeting through the model cold-started at ~7.6s and left callers in silence.
- **Defaults:** 1 attempt per short call, no retry; 60s delay before dialling; 1 callback per number per garage per day; 25 per garage per day; 150 per day estate-wide.
- **Kill switch:** `SHORT_CALL_CALLBACK_ENABLED=0` disables all dialling regardless of per-garage flags.
- **Per-garage flag `shortCallCallback` defaults to `false`.**
- **The config flag needs five touch points** (schema, `types.ts`, `validators.ts`, `config.ts`, UI). Omitting it from `validators.ts` drops it silently on every save.
- **Backend tests:** `node:test` + `node:assert/strict`, run with `cd backend && npm test` (`tsx --test src/**/*.test.ts`). Imports use `.js` extensions.
- **Agent tests:** pytest from `unified-agent/`. The suite needs a real `LIVEKIT_API_KEY` in the environment or several tests error and read as failures.
- **Per AGENTS.md, read the relevant guide in `node_modules/next/dist/docs/` before writing any Next.js code** (Task 8 only).
- **Test traffic goes to ReceptionMate Branch and nowhere else.** Never to a customer garage.

## Review Focus

Five failure modes the spec implies that no task's happy path exercises. Each has a test assigned to the task that owns the code.

1. **A callback that itself runs under 30s must not produce another callback.** Infinite redial. Pinned in Task 6 (agent-side guard) and Task 3 (`was_callback` gate).
2. **A caller ID that is really the garage's own forwarded line must never be dialled.** Advanced Service Centre forward their landline and their carrier presents the forwarding number, so this is a live condition, not a hypothetical. Pinned in Task 3.
3. **A withheld caller — `anonymous`, `unavailable`, or Twilio's `266696687` keypad sentinel — must be refused, not dialled as a literal.** Pinned in Task 3.
4. **Missing, null or malformed `weeklyOpeningHours` must mean "do not dial", never "always open" and never a crash.** Most garages' hours JSON is populated, so a happy-path test would never see it. Pinned in Task 2.
5. **Two short calls from the same number arriving together must produce exactly one dial.** Pinned in Task 4, enforced by a database unique constraint rather than a check-then-write race.

---

## File Structure

| File | Responsibility |
|---|---|
| `prisma/schema.prisma` | *modify* — `CallbackAttempt` model, `shortCallCallback` flag, `Call.fromNumber` index |
| `backend/src/utils/openingHours.ts` | *create* — "is this garage open right now", Europe/London |
| `backend/src/utils/openingHours.test.ts` | *create* |
| `backend/src/services/callbackPolicy.ts` | *create* — pure decision function, no DB, no network |
| `backend/src/services/callbackPolicy.test.ts` | *create* |
| `backend/src/routes/callbacks.ts` | *create* — `POST /api/callbacks/request`, `GET /api/callbacks` (admin) |
| `backend/src/routes/callbacks.test.ts` | *create* |
| `backend/src/services/callbackDial.ts` | *create* — the sweep and the LiveKit dial |
| `backend/src/server.ts` | *modify* — mount the router, start the sweep |
| `backend/src/utils/types.ts`, `utils/validators.ts`, `routes/config.ts` | *modify* — the flag |
| `app/agent-setup/**` | *modify* — the UI toggle |
| `receptionmate-agents/unified-agent/call_log.py` | *modify* — `should_request_callback`, `report_short_call` |
| `receptionmate-agents/unified-agent/agent.py` | *modify* — callback detection, greeting, prompt line, shutdown report |
| `receptionmate-agents/unified-agent/tests/test_short_call_callback.py` | *create* |

Two deliberate departures from the spec, both improvements found while planning:

- **`fromNumber`, not `sipNumber`.** The spec quotes LiveKit's docs, which use the protobuf name. The Node SDK calls it `fromNumber` (`node_modules/livekit-server-sdk/dist/SipClient.d.ts:100`).
- **Dedupe is per calendar day (Europe/London), not a rolling 24h.** A rolling window can only be enforced by check-then-write, which races. A day bucket stored on the row can carry a unique constraint, so the database enforces "one callback per number per garage per day" and Review Focus 5 becomes testable.

---

### Task 1: Schema

**Files:**
- Modify: `prisma/schema.prisma`

**Interfaces:**
- Consumes: nothing.
- Produces: `prisma.callbackAttempt`; `AgentConfiguration.shortCallCallback: boolean`; an index on `Call(fromNumber, createdAt)`.

- [ ] **Step 1: Add the `CallbackAttempt` model**

Append to `prisma/schema.prisma`:

```prisma
model CallbackAttempt {
  id                      String   @id @default(cuid())
  garageId                String
  garage                  Garage   @relation(fields: [garageId], references: [id], onDelete: Cascade)
  toNumber                String                      // E.164, as dialled
  // Day bucket in Europe/London ("2026-10-14"). Exists so the unique constraint below can
  // enforce one callback per number per garage per day in the database. A rolling 24h window
  // can only be done as check-then-write, which races two short calls arriving together.
  dedupeKey               String
  callerIdUsed            String?                     // what we presented as the From
  originalCallSid         String?
  originalRoom            String?
  originalDurationSeconds Int?
  // pending | dialled | answered | logged | no_answer | failed | refused
  status                  String   @default("pending")
  refusedReason           String?                     // which gate said no
  resultRoom              String?                     // the callback's own room, to join to Call
  durationSeconds         Int?
  dueAt                   DateTime                    // when the sweep may dial it
  createdAt               DateTime @default(now())
  updatedAt               DateTime @updatedAt

  @@unique([garageId, toNumber, dedupeKey])
  @@index([garageId, createdAt])
  @@index([status, dueAt])
}
```

- [ ] **Step 2: Add the flag and the `Call` index**

In `model AgentConfiguration`, beside `messagingHumanHandoff`:

```prisma
  shortCallCallback         Boolean  @default(false)
```

In `model Garage`, add to the relation list:

```prisma
  callbackAttempts          CallbackAttempt[]
```

In `model Call`, beside the existing `@@index([garageId, bookingAt])`:

```prisma
  // The callback policy asks "has this number rung back since?" — a seq scan of Call for that
  // is what OOMs this database. Call otherwise carries only a primary key.
  @@index([fromNumber, createdAt])
```

- [ ] **Step 3: Validate and generate**

Run: `cd /Users/dan/projects/portal-frontend && npx prisma validate && npx prisma generate`
Expected: `The schema at prisma/schema.prisma is valid` then a generated client.

- [ ] **Step 4: Create the migration without applying it**

Run: `npx prisma migrate dev --create-only --name short_call_callback`
Expected: a new folder under `prisma/migrations/`. Read the SQL and confirm it is additive only — `CREATE TABLE`, `ALTER TABLE ... ADD COLUMN ... DEFAULT false`, `CREATE INDEX`. No `DROP`, no `NOT NULL` added to an existing column.

- [ ] **Step 5: Confirm the dedupe constraint reached the SQL**

This is the only thing standing between two short calls arriving together and two phone calls to the same person (Review Focus 5), and it lives in generated SQL rather than in code, so check it rather than assume it.

Run:

```bash
grep -r "callbackAttempt_garageId_toNumber_dedupeKey_key\|garageId.*toNumber.*dedupeKey" prisma/migrations/*short_call_callback*/migration.sql
```

Expected: a `CREATE UNIQUE INDEX` naming all three columns. If it is absent, the `@@unique` was mistyped and the dedupe does not exist.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(callback): schema for short-call callbacks"
```

---

### Task 2: Opening-hours helper

**Files:**
- Create: `backend/src/utils/openingHours.ts`
- Test: `backend/src/utils/openingHours.test.ts`

**Interfaces:**
- Consumes: `WeeklyOpeningHours`, `WEEKDAY_ORDER`, `DayOfWeek` from `./types.js`.
- Produces: `isWithinOpeningHours(hours: unknown, at: Date, timeZone?: string): boolean`.

- [ ] **Step 1: Write the failing tests**

Create `backend/src/utils/openingHours.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isWithinOpeningHours } from './openingHours.js';

const closedAllWeek = {
  monday: { open: null, close: null, closed: true },
  tuesday: { open: null, close: null, closed: true },
  wednesday: { open: null, close: null, closed: true },
  thursday: { open: null, close: null, closed: true },
  friday: { open: null, close: null, closed: true },
  saturday: { open: null, close: null, closed: true },
  sunday: { open: null, close: null, closed: true },
};

const nineToFive = {
  ...closedAllWeek,
  wednesday: { open: '09:00', close: '17:00', closed: false },
};

// 2026-10-14 is a Wednesday. 12:00Z = 13:00 British Summer Time.
const wedMidday = new Date('2026-10-14T12:00:00Z');
const wedLateEvening = new Date('2026-10-14T20:30:00Z');
const wedBeforeOpen = new Date('2026-10-14T06:00:00Z');

test('open inside the configured window', () => {
  assert.equal(isWithinOpeningHours(nineToFive, wedMidday), true);
});

test('closed after the close time', () => {
  assert.equal(isWithinOpeningHours(nineToFive, wedLateEvening), false);
});

test('closed before the open time', () => {
  assert.equal(isWithinOpeningHours(nineToFive, wedBeforeOpen), false);
});

test('a day marked closed is closed even with times set', () => {
  const hours = { ...nineToFive, wednesday: { open: '09:00', close: '17:00', closed: true } };
  assert.equal(isWithinOpeningHours(hours, wedMidday), false);
});

// Review Focus 4. Unknown hours must never read as "always open".
test('null hours are treated as closed', () => {
  assert.equal(isWithinOpeningHours(null, wedMidday), false);
});

test('malformed hours are treated as closed', () => {
  assert.equal(isWithinOpeningHours({ wednesday: 'all day' }, wedMidday), false);
  assert.equal(isWithinOpeningHours({ wednesday: { open: 'morning', close: '17:00', closed: false } }, wedMidday), false);
  assert.equal(isWithinOpeningHours('open', wedMidday), false);
  assert.equal(isWithinOpeningHours([], wedMidday), false);
});

test('the clock is read in Europe/London, not UTC', () => {
  // 16:30Z in October is 17:30 BST — past a 17:00 close, though still before it in UTC.
  const hours = { ...closedAllWeek, wednesday: { open: '09:00', close: '17:00', closed: false } };
  assert.equal(isWithinOpeningHours(hours, new Date('2026-10-14T16:30:00Z')), false);
});

test('a close time before the open time is treated as closed', () => {
  const hours = { ...closedAllWeek, wednesday: { open: '17:00', close: '09:00', closed: false } };
  assert.equal(isWithinOpeningHours(hours, wedMidday), false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx tsx --test src/utils/openingHours.test.ts`
Expected: FAIL — cannot find module `./openingHours.js`.

- [ ] **Step 3: Write the implementation**

Create `backend/src/utils/openingHours.ts`:

```ts
// "Is this garage open right now?" — used by the short-call callback policy so nobody is rung
// back at nine at night.
//
// Everything unparseable answers FALSE. The alternative reading of a missing or malformed
// weeklyOpeningHours is "always open", which would ring customers at 3am, so the ambiguity is
// resolved towards silence on purpose.
import { WEEKDAY_ORDER, type DayOfWeek } from './types.js';

const HHMM = /^(\d{1,2}):(\d{2})$/;

/** "09:30" -> 570. Null for anything that is not a real time of day. */
function toMinutes(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = HHMM.exec(value.trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * The weekday and minute-of-day at `at`, as observed in `timeZone`.
 *
 * Read through Intl rather than from the Date's own getters: the box runs UTC and the garages
 * are on British time, so eight months of the year a UTC reading is an hour out — which at the
 * edges of the day is the difference between open and closed.
 */
function localParts(at: Date, timeZone: string): { day: DayOfWeek; minutes: number } | null {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(at);
  const weekday = parts.find((p) => p.type === 'weekday')?.value?.toLowerCase();
  const hour = parts.find((p) => p.type === 'hour')?.value;
  const minute = parts.find((p) => p.type === 'minute')?.value;
  if (!weekday || hour === undefined || minute === undefined) return null;
  if (!(WEEKDAY_ORDER as readonly string[]).includes(weekday)) return null;
  // Intl renders midnight as "24" in some ICU versions with hour12: false.
  const h = Number(hour) % 24;
  return { day: weekday as DayOfWeek, minutes: h * 60 + Number(minute) };
}

export function isWithinOpeningHours(
  hours: unknown,
  at: Date,
  timeZone = 'Europe/London',
): boolean {
  if (!hours || typeof hours !== 'object' || Array.isArray(hours)) return false;

  const now = localParts(at, timeZone);
  if (!now) return false;

  const entry = (hours as Record<string, unknown>)[now.day];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;

  const day = entry as Record<string, unknown>;
  if (day.closed !== false) return false; // absent or true both mean closed

  const open = toMinutes(day.open);
  const close = toMinutes(day.close);
  if (open === null || close === null) return false;
  if (close <= open) return false; // nonsense window; refuse rather than guess

  return now.minutes >= open && now.minutes < close;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npx tsx --test src/utils/openingHours.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/utils/openingHours.ts backend/src/utils/openingHours.test.ts
git commit -m "feat(callback): opening-hours check, closed when hours are unknown"
```

---

### Task 3: The policy decision

**Files:**
- Create: `backend/src/services/callbackPolicy.ts`
- Test: `backend/src/services/callbackPolicy.test.ts`

**Interfaces:**
- Consumes: `isWithheldCaller`, `normaliseCaller` from `../utils/callerBlocklist.js`.
- Produces:
  - `type CallbackRefusal` — the union of refusal reasons listed below.
  - `type CallbackDecision = { allow: true } | { allow: false; reason: CallbackRefusal }`
  - `type CallbackPolicyInput` — exactly the fields in the implementation below.
  - `decideCallback(input: CallbackPolicyInput): CallbackDecision`

This function does no I/O. Task 4 gathers the state and passes it in. That split is what makes every gate testable without a database.

- [ ] **Step 1: Write the failing tests**

Create `backend/src/services/callbackPolicy.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decideCallback, type CallbackPolicyInput } from './callbackPolicy.js';

// A request that should be allowed. Each test changes one field.
const ok: CallbackPolicyInput = {
  enabledGlobally: true,
  garageEnabled: true,
  callerPhone: '+447700900123',
  garageOwnNumbers: ['+441375803104', '+443330411784'],
  blocked: false,
  openNow: true,
  originalWasCallback: false,
  newerLoggedCallFromNumber: false,
  garageAttemptsToday: 0,
  estateAttemptsToday: 0,
  garageDailyCap: 25,
  estateDailyCap: 150,
};

test('a plain short call from a normal number is allowed', () => {
  assert.deepEqual(decideCallback(ok), { allow: true });
});

// Review Focus 1. The infinite-redial defect.
test('a call that was itself a callback is refused', () => {
  assert.deepEqual(decideCallback({ ...ok, originalWasCallback: true }), {
    allow: false,
    reason: 'was_callback',
  });
});

// Review Focus 2. Advanced Service Centre's forwarded landline.
test("the garage's own number is never called back", () => {
  assert.deepEqual(decideCallback({ ...ok, callerPhone: '+441375803104' }), {
    allow: false,
    reason: 'garage_own_number',
  });
});

test("the garage's own number is matched on digits, not formatting", () => {
  const spaced = decideCallback({ ...ok, callerPhone: '+44 1375 803104' });
  assert.deepEqual(spaced, { allow: false, reason: 'garage_own_number' });
  const national = decideCallback({ ...ok, callerPhone: '01375803104' });
  assert.deepEqual(national, { allow: false, reason: 'garage_own_number' });
});

// Review Focus 3. Withheld callers.
test('withheld callers are refused rather than dialled literally', () => {
  for (const value of ['anonymous', 'unavailable', 'restricted', 'withheld', '266696687']) {
    assert.deepEqual(
      decideCallback({ ...ok, callerPhone: value }),
      { allow: false, reason: 'withheld' },
      `expected ${value} to be treated as withheld`,
    );
  }
});

test('an empty or missing number is refused', () => {
  assert.deepEqual(decideCallback({ ...ok, callerPhone: null }), { allow: false, reason: 'no_number' });
  assert.deepEqual(decideCallback({ ...ok, callerPhone: '   ' }), { allow: false, reason: 'no_number' });
});

test('a number too short to be real is refused', () => {
  assert.deepEqual(decideCallback({ ...ok, callerPhone: '+4477' }), { allow: false, reason: 'no_number' });
});

test('the kill switch beats the per-garage flag', () => {
  assert.deepEqual(decideCallback({ ...ok, enabledGlobally: false }), {
    allow: false,
    reason: 'kill_switch',
  });
});

test('a garage that has not opted in is refused', () => {
  assert.deepEqual(decideCallback({ ...ok, garageEnabled: false }), { allow: false, reason: 'flag_off' });
});

test('a blocklisted caller is refused', () => {
  assert.deepEqual(decideCallback({ ...ok, blocked: true }), { allow: false, reason: 'blocklisted' });
});

test('nobody is rung back out of hours', () => {
  assert.deepEqual(decideCallback({ ...ok, openNow: false }), { allow: false, reason: 'closed' });
});

test('a caller who has already rung back and been served is left alone', () => {
  assert.deepEqual(decideCallback({ ...ok, newerLoggedCallFromNumber: true }), {
    allow: false,
    reason: 'called_back_already',
  });
});

test('the per-garage daily cap is enforced at the boundary', () => {
  assert.deepEqual(decideCallback({ ...ok, garageAttemptsToday: 24 }), { allow: true });
  assert.deepEqual(decideCallback({ ...ok, garageAttemptsToday: 25 }), {
    allow: false,
    reason: 'garage_cap',
  });
});

test('the estate daily cap is enforced at the boundary', () => {
  assert.deepEqual(decideCallback({ ...ok, estateAttemptsToday: 149 }), { allow: true });
  assert.deepEqual(decideCallback({ ...ok, estateAttemptsToday: 150 }), {
    allow: false,
    reason: 'estate_cap',
  });
});

test('the kill switch is reported ahead of any other refusal', () => {
  const everythingWrong = {
    ...ok,
    enabledGlobally: false,
    garageEnabled: false,
    callerPhone: null,
    blocked: true,
    openNow: false,
  };
  assert.deepEqual(decideCallback(everythingWrong), { allow: false, reason: 'kill_switch' });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx tsx --test src/services/callbackPolicy.test.ts`
Expected: FAIL — cannot find module `./callbackPolicy.js`.

- [ ] **Step 3: Write the implementation**

Create `backend/src/services/callbackPolicy.ts`:

```ts
// Whether to ring a caller back after a call that ended under 30 seconds.
//
// Pure on purpose. Every gate here is a condition that has either cost this estate money or
// could ring a customer who does not want ringing, and a pure function is the only version of
// this that can be tested exhaustively without a database or a phone line. The caller gathers
// the state; this decides.
//
// One place, not seven. The same reasoning as the WhatsApp sender's safety rules: a policy
// copied into each agent flavour drifts, and the drift is silent.
import { isWithheldCaller, normaliseCaller } from '../utils/callerBlocklist.js';

export type CallbackRefusal =
  | 'kill_switch'
  | 'flag_off'
  | 'no_number'
  | 'withheld'
  | 'garage_own_number'
  | 'blocklisted'
  | 'closed'
  | 'called_back_already'
  | 'was_callback'
  | 'garage_cap'
  | 'estate_cap';

export type CallbackDecision = { allow: true } | { allow: false; reason: CallbackRefusal };

export type CallbackPolicyInput = {
  /** SHORT_CALL_CALLBACK_ENABLED. False disables dialling estate-wide. */
  enabledGlobally: boolean;
  /** AgentConfiguration.shortCallCallback for this garage. */
  garageEnabled: boolean;
  /** The caller's number as the agent resolved it, or null if it had none. */
  callerPhone: string | null;
  /** The garage's own lines: twilioNumber, transferNumber, phoneNumber. */
  garageOwnNumbers: (string | null | undefined)[];
  /** isBlockedCaller() for this number on this line. */
  blocked: boolean;
  /** isWithinOpeningHours() for this garage, now. */
  openNow: boolean;
  /** Was the call that ended short itself a callback we placed? */
  originalWasCallback: boolean;
  /** Has a Call been logged from this number since the short one? */
  newerLoggedCallFromNumber: boolean;
  garageAttemptsToday: number;
  estateAttemptsToday: number;
  garageDailyCap: number;
  estateDailyCap: number;
};

/** Digits only, with a UK national 0 swapped for 44, so +44 1375…, 01375… and 441375… match. */
function comparableDigits(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.startsWith('0') && digits.length >= 10) return `44${digits.slice(1)}`;
  return digits;
}

export function decideCallback(input: CallbackPolicyInput): CallbackDecision {
  // Order matters: the reason recorded on the row is the FIRST gate that said no, and the
  // kill switch being reported ahead of everything else is what makes "why has nothing dialled
  // all morning?" answerable in one look.
  if (!input.enabledGlobally) return { allow: false, reason: 'kill_switch' };
  if (!input.garageEnabled) return { allow: false, reason: 'flag_off' };

  // Before the number is trusted at all: a callback we placed must never beget another. Most
  // callbacks end under 30 seconds — no answer, voicemail, "no thanks" — so without this the
  // feature redials the same person until a cap stops it.
  if (input.originalWasCallback) return { allow: false, reason: 'was_callback' };

  const raw = (input.callerPhone ?? '').trim();
  if (!raw) return { allow: false, reason: 'no_number' };
  if (isWithheldCaller(raw)) return { allow: false, reason: 'withheld' };

  const caller = comparableDigits(normaliseCaller(raw) || raw);
  if (caller.length < 10) return { allow: false, reason: 'no_number' };

  // The garage's own line. Their carrier presents the FORWARDING number on a diverted call, so
  // a whole day's callers can arrive as the garage's own landline — ringing it back reaches the
  // garage, repeatedly. The agent strips this case too; this is the second line of defence.
  const own = new Set(
    input.garageOwnNumbers
      .filter((n): n is string => typeof n === 'string' && n.trim() !== '')
      .map(comparableDigits)
      .filter((n) => n.length >= 10),
  );
  if (own.has(caller)) return { allow: false, reason: 'garage_own_number' };

  if (input.blocked) return { allow: false, reason: 'blocklisted' };
  if (!input.openNow) return { allow: false, reason: 'closed' };
  if (input.newerLoggedCallFromNumber) return { allow: false, reason: 'called_back_already' };

  if (input.garageAttemptsToday >= input.garageDailyCap) return { allow: false, reason: 'garage_cap' };
  if (input.estateAttemptsToday >= input.estateDailyCap) return { allow: false, reason: 'estate_cap' };

  return { allow: true };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npx tsx --test src/services/callbackPolicy.test.ts`
Expected: all tests pass. If the withheld test fails on `266696687`, read `isWithheldCaller` in `backend/src/utils/callerBlocklist.ts` — the sentinel is handled there and must not be reimplemented here.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/callbackPolicy.ts backend/src/services/callbackPolicy.test.ts
git commit -m "feat(callback): pure policy for whether to ring a short caller back"
```

---

### Task 4: The request endpoint

**Files:**
- Create: `backend/src/routes/callbacks.ts`
- Test: `backend/src/routes/callbacks.test.ts`
- Modify: `backend/src/server.ts`

**Interfaces:**
- Consumes: `decideCallback`, `CallbackPolicyInput` (Task 3); `isWithinOpeningHours` (Task 2); `isBlockedCaller` from `../utils/callerBlocklist.js`; `prisma.callbackAttempt` (Task 1).
- Produces:
  - `londonDayKey(at: Date): string` — `"2026-10-14"`, exported for tests and for Task 5.
  - `default` Express router mounted at `/api`.

- [ ] **Step 1: Write the failing tests**

These cover the two pieces with real logic and no database: the day key, and the request-body parsing. The policy itself is already covered by Task 3.

Create `backend/src/routes/callbacks.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { londonDayKey, parseCallbackRequest } from './callbacks.js';

test('the day key is the London date, not the UTC one', () => {
  // 23:30 UTC on 13 Oct is 00:30 on 14 Oct British Summer Time.
  assert.equal(londonDayKey(new Date('2026-10-13T23:30:00Z')), '2026-10-14');
  assert.equal(londonDayKey(new Date('2026-10-14T11:00:00Z')), '2026-10-14');
});

test('the day key is stable in winter, when London is UTC', () => {
  assert.equal(londonDayKey(new Date('2026-01-13T23:30:00Z')), '2026-01-13');
});

test('a well-formed report is accepted', () => {
  const parsed = parseCallbackRequest({
    garageId: 'abc123',
    callerPhone: '+447700900123',
    durationSeconds: 12,
    roomName: 'garage-abc123_+447700900123_x1',
    twilioCallSid: 'CA123',
  });
  assert.ok(parsed.ok);
  assert.equal(parsed.value.garageId, 'abc123');
  assert.equal(parsed.value.durationSeconds, 12);
});

test('a report without a garage is rejected', () => {
  const parsed = parseCallbackRequest({ callerPhone: '+447700900123', durationSeconds: 12 });
  assert.equal(parsed.ok, false);
});

test('a report of a call that was not short is rejected', () => {
  const parsed = parseCallbackRequest({ garageId: 'abc123', callerPhone: '+447700900123', durationSeconds: 45 });
  assert.equal(parsed.ok, false);
});

test('a non-numeric duration is rejected rather than coerced', () => {
  const parsed = parseCallbackRequest({ garageId: 'abc123', callerPhone: '+447700900123', durationSeconds: 'short' });
  assert.equal(parsed.ok, false);
});

test('a missing caller number is accepted and left for the policy to refuse', () => {
  // The endpoint still records a refused attempt, so "why was nobody rung back?" is answerable.
  const parsed = parseCallbackRequest({ garageId: 'abc123', durationSeconds: 4 });
  assert.ok(parsed.ok);
  assert.equal(parsed.value.callerPhone, null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx tsx --test src/routes/callbacks.test.ts`
Expected: FAIL — cannot find module `./callbacks.js`.

- [ ] **Step 3: Write the implementation**

Create `backend/src/routes/callbacks.ts`:

```ts
// The agent reports a call that ended under 30 seconds; this decides whether to ring back.
//
// The agent deliberately makes no decision. It knows the duration and the caller's number —
// already cleaned of the forwarded-number case — and nothing else it needs to know. Everything
// about whether a callback is wanted lives here, where there is one copy of it.
import type { Request, Response } from 'express';
import { Router } from 'express';

import { prisma } from '../db.js';
import { isBlockedCaller } from '../utils/callerBlocklist.js';
import { isWithinOpeningHours } from '../utils/openingHours.js';
import { decideCallback } from '../services/callbackPolicy.js';

const router = Router();

const MIN_LOGGED_SECONDS = 30;       // must match the agents' MIN_LOG_SECONDS
const DIAL_DELAY_MS = 60_000;        // let them redial us first
const GARAGE_DAILY_CAP = Number(process.env.SHORT_CALL_CALLBACK_GARAGE_CAP || 25);
const ESTATE_DAILY_CAP = Number(process.env.SHORT_CALL_CALLBACK_ESTATE_CAP || 150);

/** The same webhook secret the agent already sends to POST /api/calls. */
const ensureWebhookSecret = (req: Request): boolean => {
  const configured = process.env.WEBHOOK_SECRET;
  if (!configured) return true;
  const header =
    req.headers['x-webhook-secret'] ?? req.headers['webhook-secret'] ?? req.headers['x-webhook_secret'];
  if (Array.isArray(header)) return header.includes(configured);
  return header === configured;
};

export const callbacksEnabled = (): boolean => process.env.SHORT_CALL_CALLBACK_ENABLED !== '0';

/**
 * The London calendar day, as "YYYY-MM-DD".
 *
 * Dedupe is per day rather than a rolling 24 hours so the database can enforce it with a unique
 * constraint. Check-then-write races two short calls arriving a second apart, which is exactly
 * what happens when somebody's signal drops twice.
 */
export function londonDayKey(at: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
  return parts; // en-CA renders as YYYY-MM-DD
}

export type CallbackRequestBody = {
  garageId: string;
  callerPhone: string | null;
  durationSeconds: number;
  roomName: string | null;
  twilioCallSid: string | null;
};

export type ParseResult =
  | { ok: true; value: CallbackRequestBody }
  | { ok: false; error: string };

export function parseCallbackRequest(body: unknown): ParseResult {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body required' };
  const b = body as Record<string, unknown>;

  const garageId = typeof b.garageId === 'string' ? b.garageId.trim() : '';
  if (!garageId) return { ok: false, error: 'garageId required' };

  if (typeof b.durationSeconds !== 'number' || !Number.isFinite(b.durationSeconds)) {
    return { ok: false, error: 'durationSeconds must be a number' };
  }
  // Reported by the agent only for short calls. A longer one means the caller is confused about
  // which rule applies, and guessing would ring somebody who was already served.
  if (b.durationSeconds >= MIN_LOGGED_SECONDS || b.durationSeconds < 0) {
    return { ok: false, error: 'durationSeconds must be under 30' };
  }

  const str = (v: unknown): string | null => {
    const s = typeof v === 'string' ? v.trim() : '';
    return s === '' ? null : s;
  };

  return {
    ok: true,
    value: {
      garageId,
      callerPhone: str(b.callerPhone),
      durationSeconds: Math.floor(b.durationSeconds),
      roomName: str(b.roomName),
      twilioCallSid: str(b.twilioCallSid),
    },
  };
}

router.post('/callbacks/request', async (req: Request, res: Response) => {
  if (!ensureWebhookSecret(req)) return res.status(401).json({ error: 'Invalid webhook secret' });

  const parsed = parseCallbackRequest(req.body);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  const report = parsed.value;

  try {
    const now = new Date();
    const dayKey = londonDayKey(now);

    const garage = await prisma.garage.findUnique({
      where: { id: report.garageId },
      select: {
        id: true,
        twilioNumber: true,
        agentConfiguration: {
          select: { shortCallCallback: true, weeklyOpeningHours: true, transferNumber: true, phoneNumber: true },
        },
      },
    });
    if (!garage) return res.status(404).json({ error: 'Garage not found' });
    const config = garage.agentConfiguration;

    const [garageAttemptsToday, estateAttemptsToday, newerCall] = await Promise.all([
      prisma.callbackAttempt.count({ where: { garageId: garage.id, dedupeKey: dayKey, status: { not: 'refused' } } }),
      prisma.callbackAttempt.count({ where: { dedupeKey: dayKey, status: { not: 'refused' } } }),
      report.callerPhone
        ? prisma.call.findFirst({
            where: {
              fromNumber: report.callerPhone,
              createdAt: { gte: new Date(now.getTime() - 60 * 60 * 1000) },
            },
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);

    const decision = decideCallback({
      enabledGlobally: callbacksEnabled(),
      garageEnabled: config?.shortCallCallback === true,
      callerPhone: report.callerPhone,
      garageOwnNumbers: [garage.twilioNumber, config?.transferNumber, config?.phoneNumber],
      blocked: isBlockedCaller(report.callerPhone, garage.id),
      openNow: isWithinOpeningHours(config?.weeklyOpeningHours ?? null, now),
      // The room name carries the marker, so a callback is recognisable here even if the agent's
      // own guard were ever bypassed.
      originalWasCallback: (report.roomName ?? '').includes('_cb'),
      newerLoggedCallFromNumber: newerCall !== null,
      garageAttemptsToday,
      estateAttemptsToday,
      garageDailyCap: GARAGE_DAILY_CAP,
      estateDailyCap: ESTATE_DAILY_CAP,
    });

    // A refusal is recorded too. "Why did nobody get rung back?" is the first question anyone
    // asks, and the gate name is the answer.
    if (!decision.allow) {
      await prisma.callbackAttempt
        .create({
          data: {
            garageId: garage.id,
            toNumber: report.callerPhone ?? '',
            // Refusals must never consume the one-per-day slot a real callback needs, so they
            // are bucketed separately.
            dedupeKey: `refused:${dayKey}:${Math.random().toString(36).slice(2, 10)}`,
            status: 'refused',
            refusedReason: decision.reason,
            originalCallSid: report.twilioCallSid,
            originalRoom: report.roomName,
            originalDurationSeconds: report.durationSeconds,
            dueAt: now,
          },
        })
        .catch((e) => console.error('[callback] could not record refusal:', e?.message));
      return res.json({ queued: false, reason: decision.reason });
    }

    try {
      const attempt = await prisma.callbackAttempt.create({
        data: {
          garageId: garage.id,
          toNumber: report.callerPhone as string,
          dedupeKey: dayKey,
          status: 'pending',
          originalCallSid: report.twilioCallSid,
          originalRoom: report.roomName,
          originalDurationSeconds: report.durationSeconds,
          dueAt: new Date(now.getTime() + DIAL_DELAY_MS),
        },
      });
      return res.json({ queued: true, attemptId: attempt.id });
    } catch (e: unknown) {
      // P2002 = the unique constraint. Another short call from this number today already
      // queued a callback; that is the dedupe working, not an error.
      if ((e as { code?: string })?.code === 'P2002') {
        return res.json({ queued: false, reason: 'already_queued_today' });
      }
      throw e;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'failed';
    console.error('[callback] request error:', msg);
    return res.status(500).json({ error: msg });
  }
});

export default router;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npx tsx --test src/routes/callbacks.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Mount the router**

In `backend/src/server.ts`, beside the other routers (follow the `outboundCallsRouter` pattern at line 61 and line 170):

```ts
import callbacksRouter from './routes/callbacks.js';
```

```ts
app.use('/api', callbacksRouter);
```

- [ ] **Step 6: Verify the build**

Run: `cd backend && npx tsc --noEmit`
Expected: no errors. Note the pre-existing `chatAgentV2.ts` build failure — if `tsc` reports errors only in that file, they are not from this work.

- [ ] **Step 7: Commit**

```bash
git add backend/src/routes/callbacks.ts backend/src/routes/callbacks.test.ts backend/src/server.ts
git commit -m "feat(callback): endpoint for the agent to report a short call"
```

---

### Task 5: The dial and the sweep

**Files:**
- Create: `backend/src/services/callbackDial.ts`
- Test: `backend/src/services/callbackDial.test.ts`
- Modify: `backend/src/server.ts`

**Interfaces:**
- Consumes: `prisma.callbackAttempt` (Task 1); `AgentDispatchClient`, `SipClient` from `livekit-server-sdk`. Nothing from Task 4 at runtime — the sweep reads the rows Task 4 wrote.
- Produces:
  - `callbackRoomName(garageId: string, toNumber: string): string`
  - `callerIdFor(garage: { outboundCallerId: string | null; outboundCallerIdVerified: boolean; twilioNumber: string | null }): string | null`
  - `dialCallback(attemptId: string): Promise<void>`
  - `startCallbackSweep(intervalMs?: number): void`

- [ ] **Step 1: Write the failing tests**

Create `backend/src/services/callbackDial.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { callbackRoomName, callerIdFor } from './callbackDial.js';

test('the room name carries the garage, the caller and the callback marker', () => {
  const room = callbackRoomName('11111111-2222-3333-4444-555555555555', '+447700900123');
  assert.match(room, /^garage-11111111-2222-3333-4444-555555555555_\+447700900123_cb[a-z0-9]+$/);
});

// The agent parses the garage id and the caller's number straight out of the room name. If the
// marker broke either regex, every callback would boot with no garage config at all.
test('the room name still matches the agent’s own parsers', () => {
  const room = callbackRoomName('11111111-2222-3333-4444-555555555555', '+447700900123');
  const garageRe = /garage-([0-9a-fA-F-]{6,})/;
  const phoneRe = /garage-[0-9a-fA-F-]{8,}_+(\+?\d{6,})/;
  assert.equal(garageRe.exec(room)?.[1], '11111111-2222-3333-4444-555555555555');
  assert.equal(phoneRe.exec(room)?.[1], '+447700900123');
});

test('room names are unique per call', () => {
  const a = callbackRoomName('abc123', '+447700900123');
  const b = callbackRoomName('abc123', '+447700900123');
  assert.notEqual(a, b);
});

test('a verified caller ID is preferred', () => {
  const id = callerIdFor({
    outboundCallerId: '+441752123456',
    outboundCallerIdVerified: true,
    twilioNumber: '+443330411784',
  });
  assert.equal(id, '+441752123456');
});

// Only 2 of 63 garages are verified, so this is the common path, not the exception.
test('an unverified caller ID falls back to the garage’s Twilio number', () => {
  const id = callerIdFor({
    outboundCallerId: '+441752123456',
    outboundCallerIdVerified: false,
    twilioNumber: '+443330411784',
  });
  assert.equal(id, '+443330411784');
});

test('a garage with no usable number at all yields null', () => {
  assert.equal(
    callerIdFor({ outboundCallerId: null, outboundCallerIdVerified: false, twilioNumber: null }),
    null,
  );
});

test('the caller ID is normalised to E.164 digits', () => {
  const id = callerIdFor({
    outboundCallerId: null,
    outboundCallerIdVerified: false,
    twilioNumber: '+44 333 041 1784',
  });
  assert.equal(id, '+443330411784');
});
```

The last one matters: `Garage.twilioNumber` is stored for display, with spaces. Passing it through verbatim is what put four malformed numbers on the demo line's trunk.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx tsx --test src/services/callbackDial.test.ts`
Expected: FAIL — cannot find module `./callbackDial.js`.

- [ ] **Step 3: Write the implementation**

Create `backend/src/services/callbackDial.ts`:

```ts
// Placing the callback: a room, an agent dispatched into it, then the caller dialled in.
//
// The dial path is the one the unified agent already uses for warm transfers, so the trunk and
// its credentials are known to work. What is new is that WE create the room rather than an
// inbound trunk, so the agent must be dispatched explicitly — it is a named agent, and without
// an explicit dispatch the room is created and no worker ever joins.
import { AgentDispatchClient, SipClient } from 'livekit-server-sdk';

import { prisma } from '../db.js';

const UNIFIED_AGENT_NAME = 'unified-agent';
const RING_SECONDS = 25;            // matches the transfer ring limit Dan set
const MAX_CALL_SECONDS = 600;       // the agents' own 10-minute cap

const config = () => {
  const url = process.env.LIVEKIT_UNIFIED_URL;
  const key = process.env.LIVEKIT_UNIFIED_API_KEY;
  const secret = process.env.LIVEKIT_UNIFIED_API_SECRET;
  const trunk = (process.env.LIVEKIT_SIP_OUTBOUND_TRUNK || process.env.LIVEKIT_OUTBOUND_TRUNK_ID || '').trim();
  return url && key && secret && trunk ? { url, key, secret, trunk } : null;
};

/** E.164 digits only. twilioNumber is stored for display — "+44 333 041 1784" — and no carrier
 *  presents it that way. Passing it through verbatim is what broke the demo line's trunk. */
function e164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[^\d+]/g, '');
  return /^\+\d{10,15}$/.test(cleaned) ? cleaned : null;
}

/**
 * `garage-<id>_<caller>_cb<rand>`.
 *
 * The shape is the agent's: it parses the garage id and the caller's number straight out of the
 * room name. The `cb` marker sits AFTER the number, where neither of its regexes reaches, which
 * is checked by this module's tests.
 */
export function callbackRoomName(garageId: string, toNumber: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `garage-${garageId}_${toNumber}_cb${rand}`;
}

export function callerIdFor(garage: {
  outboundCallerId: string | null;
  outboundCallerIdVerified: boolean;
  twilioNumber: string | null;
}): string | null {
  if (garage.outboundCallerIdVerified) {
    const verified = e164(garage.outboundCallerId);
    if (verified) return verified;
  }
  return e164(garage.twilioNumber);
}

export async function dialCallback(attemptId: string): Promise<void> {
  const cfg = config();
  const attempt = await prisma.callbackAttempt.findUnique({
    where: { id: attemptId },
    include: {
      garage: {
        select: {
          id: true,
          name: true,
          twilioNumber: true,
          outboundCallerId: true,
          outboundCallerIdVerified: true,
        },
      },
    },
  });
  if (!attempt || attempt.status !== 'pending') return;

  const fail = (reason: string) =>
    prisma.callbackAttempt.update({
      where: { id: attempt.id },
      data: { status: 'failed', refusedReason: reason },
    });

  if (!cfg) {
    console.warn('[callback] LIVEKIT_UNIFIED_* or the outbound trunk is not configured — not dialling');
    await fail('not_configured');
    return;
  }

  const fromNumber = callerIdFor(attempt.garage);
  if (!fromNumber) {
    await fail('no_caller_id');
    return;
  }

  const room = callbackRoomName(attempt.garageId, attempt.toNumber);

  // Marked dialled BEFORE the dial, not after. The attempt is spent the moment the phone starts
  // ringing, so that is where it is recorded — including on every path out of here, exceptions
  // we have not thought of included. Recording it after would let a crash mid-dial leave the row
  // pending for the sweep to pick up and ring the customer a second time.
  await prisma.callbackAttempt.update({
    where: { id: attempt.id },
    data: { status: 'dialled', callerIdUsed: fromNumber, resultRoom: room },
  });

  try {
    // Explicit dispatch first, so a worker is already on its way before the phone rings and the
    // caller does not answer to silence.
    const dispatch = new AgentDispatchClient(cfg.url, cfg.key, cfg.secret);
    await dispatch.createDispatch(room, UNIFIED_AGENT_NAME, {
      metadata: JSON.stringify({ callback: true, to: attempt.toNumber, garageId: attempt.garageId }),
    });

    const sip = new SipClient(cfg.url, cfg.key, cfg.secret);
    await sip.createSipParticipant(cfg.trunk, attempt.toNumber, room, {
      fromNumber,
      participantIdentity: `sip_${attempt.toNumber}`,
      participantName: 'Callback recipient',
      playDialtone: false,
      ringingTimeout: RING_SECONDS,
      maxCallDuration: MAX_CALL_SECONDS,
      waitUntilAnswered: true,
    });

    await prisma.callbackAttempt.update({ where: { id: attempt.id }, data: { status: 'answered' } });
    console.log(`[callback] ${attempt.garage.name}: ${attempt.toNumber} answered (room ${room})`);
  } catch (err: unknown) {
    // A ring-out raises here too, and is the ordinary outcome rather than a bug. One attempt
    // only: nobody is rung twice over one dropped call.
    const msg = err instanceof Error ? err.message : 'dial failed';
    console.log(`[callback] ${attempt.garage.name}: ${attempt.toNumber} did not connect — ${msg}`);
    await prisma.callbackAttempt.update({
      where: { id: attempt.id },
      data: { status: 'no_answer', refusedReason: msg.slice(0, 200) },
    });
  }
}

let timer: NodeJS.Timeout | null = null;

/**
 * Dial whatever has come due. A sweep rather than a setTimeout per attempt so a restart in the
 * 60-second window does not silently lose the callback.
 */
export function startCallbackSweep(intervalMs = 30_000): void {
  if (timer) return;
  const run = async () => {
    try {
      const due = await prisma.callbackAttempt.findMany({
        where: { status: 'pending', dueAt: { lte: new Date() } },
        select: { id: true },
        take: 10,
      });
      for (const { id } of due) await dialCallback(id);
    } catch (e: unknown) {
      console.error('[callback] sweep error:', e instanceof Error ? e.message : e);
    }
  };
  timer = setInterval(() => void run(), intervalMs);
  console.log(`[callback] sweep started (every ${Math.round(intervalMs / 1000)}s)`);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npx tsx --test src/services/callbackDial.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Start the sweep**

In `backend/src/server.ts`, where the other sweeps start (follow `ticketStaleSweep`):

```ts
import { startCallbackSweep } from './services/callbackDial.js';
```

```ts
startCallbackSweep();
```

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/callbackDial.ts backend/src/services/callbackDial.test.ts backend/src/server.ts
git commit -m "feat(callback): dial the caller back over the unified outbound trunk"
```

---

### Task 6: Agent reports the short call, and never reports its own

**Files:**
- Modify: `receptionmate-agents/unified-agent/call_log.py`
- Modify: `receptionmate-agents/unified-agent/agent.py` (the shutdown path around line 8704)
- Test: `receptionmate-agents/unified-agent/tests/test_short_call_callback.py`

**Interfaces:**
- Consumes: `MIN_LOG_SECONDS` (already in `call_log.py`).
- Produces:
  - `call_log.should_request_callback(duration_seconds, *, is_callback, is_web, is_simulation, post_calls) -> bool`
  - `call_log.report_short_call(*, garage_id, caller_phone, twilio_call_sid, room_name, duration_seconds) -> None`

- [ ] **Step 1: Write the failing tests**

Create `receptionmate-agents/unified-agent/tests/test_short_call_callback.py`:

```python
"""The short-call callback: who gets reported, and the loop that must never start."""
import call_log


def _args(**over):
    base = dict(is_callback=False, is_web=False, is_simulation=False, post_calls=True)
    base.update(over)
    return base


def test_a_short_sip_call_is_reported():
    assert call_log.should_request_callback(12, **_args()) is True


def test_a_long_call_is_not_reported():
    assert call_log.should_request_callback(31, **_args()) is False
    assert call_log.should_request_callback(call_log.MIN_LOG_SECONDS, **_args()) is False


# THE loop guard. Most callbacks end under 30 seconds — no answer, voicemail, "no thanks" — so
# without this each one asks for another and the customer is rung until a cap stops it.
def test_a_short_callback_never_asks_for_another_callback():
    assert call_log.should_request_callback(8, **_args(is_callback=True)) is False


def test_a_browser_demo_is_not_reported():
    assert call_log.should_request_callback(8, **_args(is_web=True)) is False


def test_a_simulated_call_is_not_reported():
    assert call_log.should_request_callback(8, **_args(is_simulation=True)) is False


def test_nothing_is_reported_when_posting_is_off():
    assert call_log.should_request_callback(8, **_args(post_calls=False)) is False


def test_a_zero_second_call_is_still_reported():
    # The portal's policy decides whether a 2-second hangup is worth ringing back. The agent's
    # job is to report, not to judge.
    assert call_log.should_request_callback(0, **_args()) is True
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/dan/projects/receptionmate-agents/unified-agent && python -m pytest tests/test_short_call_callback.py -v`
Expected: FAIL — `AttributeError: module 'call_log' has no attribute 'should_request_callback'`.

- [ ] **Step 3: Add the decision and the reporter**

In `receptionmate-agents/unified-agent/call_log.py`, after `MIN_LOG_SECONDS`:

```python
# Where the portal takes short-call reports. Separate from PORTAL_API_URL because the short-call
# path is not a call log — nothing about this call is ever shown to the garage.
PORTAL_CALLBACK_URL = os.getenv(
    "PORTAL_CALLBACK_URL", "https://portal.receptionmate.co.uk/api/callbacks/request")


def should_request_callback(duration_seconds: int, *, is_callback: bool, is_web: bool,
                            is_simulation: bool, post_calls: bool) -> bool:
    """Whether to ask the portal to ring this caller back.

    Deliberately a decision about THIS call only — whether a callback is actually wanted is the
    portal's to make, in one place, for all seven agent flavours.

    is_callback is the guard that matters. A callback is itself a call, and most callbacks end
    under 30 seconds: no answer, voicemail, or "no thanks, I've sorted it". Without this line,
    each one reports itself as a short call and asks for another. In code rather than in the
    prompt because a prompt instruction gets skipped eventually, and this one ends with a
    customer's phone ringing all afternoon.
    """
    if not post_calls:
        return False
    if is_callback or is_web or is_simulation:
        return False
    return duration_seconds < MIN_LOG_SECONDS


async def report_short_call(*, garage_id: str, caller_phone: str, twilio_call_sid: str,
                            room_name: str, duration_seconds: int) -> None:
    """Tell the portal this call ended short. Fire and forget; never raises.

    A short timeout on purpose: this runs in the shutdown path, and a slow portal must not hold
    a job process open behind it.
    """
    if not garage_id:
        return
    payload = {
        "garageId": garage_id,
        "callerPhone": caller_phone or None,
        "twilioCallSid": twilio_call_sid or None,
        "roomName": room_name or None,
        "durationSeconds": int(duration_seconds),
    }
    headers = {"Content-Type": "application/json"}
    if PORTAL_WEBHOOK_SECRET:
        headers["x-webhook-secret"] = PORTAL_WEBHOOK_SECRET
    try:
        timeout = aiohttp.ClientTimeout(total=5)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(PORTAL_CALLBACK_URL, json=payload, headers=headers) as resp:
                body = await resp.text()
                logger.info("[callback] reported %ss call for %s -> %s %s",
                            duration_seconds, garage_id, resp.status, body[:200])
    except Exception as e:
        logger.warning("[callback] could not report short call: %s", e)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/dan/projects/receptionmate-agents/unified-agent && python -m pytest tests/test_short_call_callback.py -v`
Expected: 8 passed.

- [ ] **Step 5: Wire it into the shutdown path**

In `agent.py`, in `_on_shutdown` immediately after `duration = int(time.monotonic() - _call_start)` (line 8704), before the summary and `post_call` work:

```python
    # A call that ended short never reaches the portal's call log — and now it asks for a
    # callback instead. Before the summary, because generating one costs an LLM round trip and
    # this path does not need it.
    if call_log.should_request_callback(duration, is_callback=IS_CALLBACK, is_web=IS_WEB_ROOM,
                                        is_simulation=_is_simulation, post_calls=POST_CALLS):
        await call_log.report_short_call(
            garage_id=_gid,
            caller_phone=CALLER_PHONE or "",
            twilio_call_sid=TWILIO_CALL_SID or "",
            room_name=_room,
            duration_seconds=duration,
        )
```

`IS_CALLBACK` is introduced in Task 7. Until then it does not exist, so finish Task 7 before running the agent — the two tasks are one deployable unit even though they test separately.

- [ ] **Step 6: Check nothing else broke**

Run: `cd /Users/dan/projects/receptionmate-agents/unified-agent && python -m pytest tests/ -q`
Expected: the suite's usual result. A real `LIVEKIT_API_KEY` must be set or several tests error for want of it and read as failures.

- [ ] **Step 7: Commit**

```bash
cd /Users/dan/projects/receptionmate-agents
git add unified-agent/call_log.py unified-agent/agent.py unified-agent/tests/test_short_call_callback.py
git commit -m "feat(callback): report short calls to the portal, never a callback's own"
```

---

### Task 7: Agent recognises the callback and greets accordingly

**Files:**
- Modify: `receptionmate-agents/unified-agent/agent.py`
- Test: `receptionmate-agents/unified-agent/tests/test_short_call_callback.py` (append)

**Interfaces:**
- Consumes: `PERSONA_NAME`, `BRANCH_NAME` (set by `configure_for_garage`).
- Produces:
  - `is_callback_job(metadata: str, room_name: str) -> bool` (module level in `agent.py`)
  - `callback_greeting(persona_name: str, branch_name: str) -> str` (module level in `agent.py`)
  - `IS_CALLBACK` global, set in the entrypoint.

- [ ] **Step 1: Write the failing tests**

Append to `receptionmate-agents/unified-agent/tests/test_short_call_callback.py`:

```python
import agent as agent_mod


def test_callback_recognised_from_dispatch_metadata():
    assert agent_mod.is_callback_job('{"callback": true, "to": "+447700900123"}', "room-x") is True


def test_callback_recognised_from_the_room_name_alone():
    # Belt and braces: if dispatch metadata is ever lost, the room name still says what this is.
    # Getting this wrong means greeting someone with "we missed your call" when they just rang.
    assert agent_mod.is_callback_job("", "garage-abc123_+447700900123_cbx7y2") is True


def test_an_ordinary_inbound_call_is_not_a_callback():
    assert agent_mod.is_callback_job("", "garage-abc123_+447700900123_a1b2") is False
    assert agent_mod.is_callback_job('{"callback": false}', "garage-abc123_+447700900123_a1b2") is False


def test_malformed_metadata_does_not_crash_or_claim_a_callback():
    assert agent_mod.is_callback_job("not json", "garage-abc123_+447700900123_a1b2") is False
    assert agent_mod.is_callback_job(None, "garage-abc123_+447700900123_a1b2") is False


def test_a_web_demo_room_is_not_a_callback():
    assert agent_mod.is_callback_job("", "garage-abc123_web_a1b2") is False


def test_the_greeting_is_exactly_the_agreed_copy():
    assert agent_mod.callback_greeting("Leah", "Smith's Garage") == (
        "Hi, it's Leah for Smith's Garage. We've just missed a call from you — how can I help?"
    )
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/dan/projects/receptionmate-agents/unified-agent && python -m pytest tests/test_short_call_callback.py -v`
Expected: FAIL — `module 'agent' has no attribute 'is_callback_job'`.

- [ ] **Step 3: Add the two functions**

In `agent.py`, beside `garage_id_from_room` (around line 422):

```python
# Set in the entrypoint. True when WE placed this call, which changes the opening line and
# suppresses the short-call report that would otherwise start a redial loop.
IS_CALLBACK = False


def is_callback_job(metadata, room_name: str) -> bool:
    """Is this session a callback we placed, rather than a caller ringing in?

    Two signals, because getting it wrong is audible: an inbound caller told "we've just missed
    a call from you" is bewildering, and a callback that greets normally never explains why the
    garage is ringing. Dispatch metadata is authoritative; the room name's `_cb` marker covers
    the case where metadata is lost.
    """
    try:
        import json as _json
        meta = _json.loads(metadata or "{}")
        if isinstance(meta, dict) and meta.get("callback") is True:
            return True
    except Exception:
        pass
    name = room_name or ""
    # Guard the marker against a caller number that happens to contain "cb" — it cannot, being
    # digits, but the room's random suffix could, so match only the segment that carries it.
    return "_cb" in name.rsplit("_", 1)[-1][:3] or name.rsplit("_", 1)[-1].startswith("cb")


def callback_greeting(persona_name: str, branch_name: str) -> str:
    """The opening line on a callback. Copy agreed with Dan 2026-10-14 — do not reword."""
    return (f"Hi, it's {persona_name} for {branch_name}. "
            f"We've just missed a call from you — how can I help?")
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/dan/projects/receptionmate-agents/unified-agent && python -m pytest tests/test_short_call_callback.py -v`
Expected: 14 passed.

- [ ] **Step 5: Set the flag in the entrypoint**

In `agent.py`, in the entrypoint beside `IS_WEB_ROOM` (around line 8098), add `IS_CALLBACK` to the `global` statement and set it:

```python
    IS_CALLBACK = is_callback_job(getattr(ctx.job, "metadata", "") or "", _room)
    if IS_CALLBACK:
        logger.info("[callback] this is a callback we placed — greeting accordingly")
```

- [ ] **Step 6: Use the greeting**

In `on_enter` (around line 3977), replace the greeting selection:

```python
        if IS_CALLBACK:
            # Not the garage's configured greeting: that one thanks them for calling, and we
            # called them. Spoken straight to TTS like the others — routing a greeting through
            # the LLM cold-started at ~7.6s and left callers in silence.
            greeting = callback_greeting(PERSONA_NAME, BRANCH_NAME)
        elif GREETING_LINE:
            greeting = _render_greeting(GREETING_LINE)
        else:
            greeting = f"Hello, you're through to {BRANCH_NAME}, {PERSONA_NAME} speaking — how can I help?"
```

- [ ] **Step 7: Tell the model it placed the call**

The system prompt is assembled at construction (`agent.py:3703`), where `build_instructions()` is then extended with the caller-profile and SIP-phone blocks. Add a third block the same way — at construction, not pushed in later: an instruction update racing the model's first reply is a bug this agent has already had, and it recognised the caller on only three calls out of six.

Add beside the other block builders:

```python
def _build_callback_block() -> str:
    """Tell the model it rang THEM. Without this it opens as though they called us."""
    return ("\n\nTHIS IS A CALLBACK YOU PLACED. They rang the garage a minute ago and the call "
            "did not connect properly, so you are ringing them back. Never thank them for "
            "calling and never ask what made them get in touch — they already told the garage "
            "nothing and were cut off, and asking implies they rang just now. If they say it "
            "was a wrong number, or they have since sorted it, apologise briefly for troubling "
            "them and let them go rather than working through the usual questions.")
```

Then at `agent.py:3703`, after `_instr = build_instructions()`:

```python
        if IS_CALLBACK:
            _instr += _build_callback_block()
```

- [ ] **Step 8: Take the caller's number from the dispatch metadata**

On an inbound call the SIP participant is the caller. On a callback it is the *callee*, so the inbound-shaped resolution does not mean the same thing — and worse, the guard at `agent.py:8167` blanks a number matching the garage's own lines, which is a rule written for forwarded inbound calls.

In the entrypoint, after `CALLER_PHONE` is resolved and the own-number guard has run, override it for a callback:

```python
    if IS_CALLBACK:
        # Authoritative: it is the number WE asked LiveKit to dial. Parsing it back off the
        # participant or the room name would be inferring what we already know.
        try:
            import json as _json
            _meta_to = str((_json.loads(getattr(ctx.job, "metadata", "") or "{}") or {}).get("to") or "").strip()
        except Exception:
            _meta_to = ""
        if _meta_to:
            CALLER_PHONE = _meta_to
```

- [ ] **Step 9: Mark the logged call as a callback**

A callback that runs 30s+ posts through `post_call` unchanged, which is the behaviour Dan asked for. One addition so "did callbacks book anything?" is answerable later: in the `extra_metrics` dict passed to `call_log.post_call` (around `agent.py:8775`), beside `"transcript_turns"`:

```python
                           # True when WE placed this call. Costs nothing, and without it a
                           # callback is indistinguishable from an ordinary inbound call.
                           "callback": IS_CALLBACK,
```

- [ ] **Step 10: Run the whole agent suite**

Run: `cd /Users/dan/projects/receptionmate-agents/unified-agent && python -m pytest tests/ -q`
Expected: the suite's usual result, with the 14 new tests passing. `test_no_shadowed_module_names.py` must still pass — a duplicate module-level definition inside a class body has silently stripped this agent's methods before.

- [ ] **Step 11: Commit**

```bash
cd /Users/dan/projects/receptionmate-agents
git add unified-agent/agent.py unified-agent/tests/test_short_call_callback.py
git commit -m "feat(callback): callback greeting and prompt for outbound calls"
```

---

### Task 8: The per-garage flag, all five touch points

**Files:**
- Modify: `backend/src/utils/types.ts`
- Modify: `backend/src/utils/validators.ts`
- Modify: `backend/src/routes/config.ts` (four places)
- Modify: the agent-setup UI page that renders `messagingHumanHandoff`

**Interfaces:**
- Consumes: `shortCallCallback` from Task 1's schema.
- Produces: the flag surviving a save, readable by Task 4.

A field missing from `validators.ts` is dropped on every save with no error. That is how ten settings reverted and a garage's FAQs were wiped to `[]`. Follow `messagingHumanHandoff` exactly.

- [ ] **Step 1: Write the failing test**

The schema is `upsertAgentConfigurationSchema`, exported from `backend/src/utils/validators.ts:255`. Add to the existing `backend/src/routes/config.integration.test.ts`, which currently imports only from `./config.js`, so the import is new:

```ts
import { upsertAgentConfigurationSchema } from '../utils/validators.js';

// A field missing from this schema is dropped on every save with no error — the path that
// quietly reverted ten settings and wiped a garage's FAQs to []. This test is the tripwire.
test('shortCallCallback survives the validator', () => {
  const parsed = upsertAgentConfigurationSchema.parse({ shortCallCallback: true });
  assert.equal(parsed.shortCallCallback, true);
});

test('shortCallCallback set to false survives, rather than vanishing', () => {
  const parsed = upsertAgentConfigurationSchema.parse({ shortCallCallback: false });
  assert.equal(parsed.shortCallCallback, false);
});
```

If `.parse({})` throws because other fields are required, build the object from whatever minimal valid payload the file's other tests use rather than loosening the schema.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npx tsx --test src/routes/config.integration.test.ts`
Expected: FAIL — `shortCallCallback` is stripped, so the assertion gets `undefined`.

- [ ] **Step 3: Add the five touch points**

`backend/src/utils/types.ts`, beside `messagingHumanHandoff` (line 259):

```ts
  shortCallCallback?: boolean;
```

`backend/src/utils/validators.ts`, beside line 311:

```ts
  shortCallCallback: z.boolean().optional(),
```

`backend/src/routes/config.ts` — all four places that mention `messagingHumanHandoff` (lines 334, 403, 532, 1347), following each one's shape. Note that the default here is **off**, the opposite of `messagingHumanHandoff`:

```ts
  shortCallCallback: false,                                              // ~line 334, defaults
  shortCallCallback: (config as any).shortCallCallback === true,         // ~line 403
  shortCallCallback: (configuration as Record<string, unknown>).shortCallCallback === true,  // ~line 532
  shortCallCallback: data.shortCallCallback === true,                    // ~line 1347, the save
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd backend && npx tsx --test src/routes/config.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the UI toggle**

**Read `node_modules/next/dist/docs/` for the relevant guide before writing this — per AGENTS.md this Next.js version differs from what you know.**

Find the toggle that renders `messagingHumanHandoff` (`grep -rn "messagingHumanHandoff" app/`) and add one beside it, labelled:

> **Call missed callers back** — When a call ends in under 30 seconds, ring the caller back and try to help. Off by default.

- [ ] **Step 6: Verify the build**

Run: `cd backend && npx tsc --noEmit && cd .. && npx next build`
Expected: no new errors. Pre-existing `chatAgentV2.ts` errors are not from this work.

- [ ] **Step 7: Commit**

```bash
git add backend/src/utils/types.ts backend/src/utils/validators.ts backend/src/routes/config.ts backend/src/routes/config.integration.test.ts app
git commit -m "feat(callback): per-garage opt-in toggle"
```

---

### Task 9: Admin visibility

**Files:**
- Modify: `backend/src/routes/callbacks.ts`

**Interfaces:**
- Consumes: `prisma.callbackAttempt`; `authenticate` from `../middleware/auth.js`.
- Produces: `GET /api/callbacks?garageId=&limit=`, staff only.

Without this there is no way to tell the feature is alive, or that it has started redialling the same number — the shape of both the watchdog's single-garage blind spot and the support-hub ingest gap. Nothing here is garage-facing: a failed callback stays invisible to the garage, as specified.

- [ ] **Step 1: Add the route**

In `backend/src/routes/callbacks.ts`:

```ts
import { authenticate } from '../middleware/auth.js';

// Staff only, and deliberately not garage-facing: a callback that failed must leave no trace a
// garage can see. This is how we tell the feature is working at all.
router.get('/callbacks', authenticate, async (req: Request, res: Response) => {
  if (req.user?.role !== 'RECEPTIONMATE_STAFF') return res.status(403).json({ error: 'Forbidden' });

  const garageId = String(req.query.garageId || '').trim();
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));

  const rows = await prisma.callbackAttempt.findMany({
    where: garageId ? { garageId } : undefined,
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true, garageId: true, toNumber: true, status: true, refusedReason: true,
      callerIdUsed: true, originalDurationSeconds: true, durationSeconds: true,
      resultRoom: true, createdAt: true,
      garage: { select: { name: true } },
    },
  });

  return res.json({ attempts: rows });
});
```

- [ ] **Step 2: Verify the build and the suite**

Run: `cd backend && npx tsc --noEmit && npm test`
Expected: no new errors; all tests pass.

- [ ] **Step 3: Commit**

```bash
git add backend/src/routes/callbacks.ts
git commit -m "feat(callback): admin list of callback attempts"
```

---

## After the tasks: deployment and the live check

Not plan steps — these need Dan, and the migration touches production.

1. Use the `deploying` skill. The migration is additive; apply it on the usual cycle.
2. Deploy the agent by **git push** to `danny901233/receptionmate-agents` — CI deploys it; do not run `lk deploy` by hand.
3. Confirm the outbound trunk's `numbers` is `"*"`, or `fromNumber` is ignored and every callback presents the trunk's default number. Check with `lk sip outbound list`.
4. Set `shortCallCallback` on **🔵 Test — GH v3 only** (`+441708204853`). NOT ReceptionMate Branch: it runs `receptionmate-agent`, so no short-call report can ever arrive, and its `transferNumber` is Dan's own mobile, so a call he places from that handset is refused `garage_own_number` every time. Either failure looks exactly like the feature being broken. Test — GH v3 is `isTestAccount`, already on `unified-agent`, and on Garage Hive, so the booking path is exercised too.
5. Check the clock first. Its hours are 08:30–17:30 and the policy refuses `closed` outside them, so an evening test produces a refusal row and nothing else.
6. Ring `+441708204853` from a phone that is not one of that garage's own numbers, hang up after ~10 seconds, and confirm: a `CallbackAttempt` row appears; the phone rings back inside ~90 seconds; **the greeting does not begin until you have answered** (the bug the review caught — it used to talk over the ringing); and the greeting is the agreed line.
7. Then hang up on the callback after 5 seconds and confirm **no second callback is placed**, and that nothing appears in the garage's call log. This is the loop guard in production; the unit tests are not sufficient evidence on their own.
8. The caller-ID question cannot be settled here, and the plan should stop pretending it can. Test — GH v3 has no verified `outboundCallerId`, so the callback presents its Twilio number — which we own, so Twilio always accepts it. ReceptionMate Branch's "verified" caller ID is also one of our own Twilio numbers. Whether Twilio accepts a `From` we do NOT own over the elastic trunk is only answerable once a real garage's own landline has been verified, i.e. on the first customer.
9. Leave it on that one garage for a week and read `GET /api/callbacks` before enabling a second.
