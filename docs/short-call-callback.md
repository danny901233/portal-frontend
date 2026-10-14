# Short-call callback — the agent rings them back (design)

**Decision:** when a call ends under 30 seconds, the unified agent rings the caller back and tries to help. If that callback works it appears in the call logs like any other call. If it fails, or it too runs short, nothing reaches the garage.

Agreed with Dan 2026-10-14. This document is the spec; no code written yet.

## Why, and how big the problem actually is

Every agent discards calls under 30 seconds before they are logged — `MIN_LOG_SECONDS` in each agent's `call_log.py`, and a matching delete in `backend/src/routes/voice.ts` when a short recording arrives. So the short-call population is invisible in the portal: a count of `Call` rows under 30s over the last 14 days returns **zero**.

`TwilioRecording` rows survive that deletion, and they are the only trace. Last 14 days:

| recording length | calls |
|---|---|
| ≤ 5s | 619 |
| 6–10s | 311 |
| 11–15s | 103 |
| 16–22s | 135 |
| 23–29s | 78 |
| **under 30s total** | **1,246** (45% of 2,791 recorded calls, ≈89/day) |

A proxy rather than a census — it only holds calls that produced a recording — but the shape is clear: three quarters of short calls are ten seconds or less, and the band where a garage plausibly lost a job is 16–29s, roughly 15 calls a day across 63 garages.

Dan's decision is to call back on **any** sub-30s call rather than only that band. The cost of that choice is set out under "Caps and cost" below, and is controlled by caps rather than by a duration floor.

## Scope

In scope:

- The **unified agent only** (`receptionmate-agents/unified-agent`). The other six flavours are untouched.
- Per-garage opt-in, default off, ReceptionMate Branch first.
- Approach 1: the agent dials out over LiveKit's SIP outbound trunk.

Out of scope for this build: the other agents; any garage-facing missed-call list; text/WhatsApp follow-up; calls where the caller rings off before the agent session starts (see "Known gaps").

## Architecture

### 1. The agent reports; it does not decide

Trigger point is the agent's shutdown path, `unified-agent/agent.py` — `duration` is computed at line 8704 and `call_log.post_call` already skips posting under 30s at `call_log.py:303`. At that same point, when all of the following hold, the agent POSTs a report to the portal and does nothing else:

- `duration < 30`
- it was a real SIP call — not a web room (`IS_WEB_ROOM`), not a simulation (`_is_simulation`), and `POST_CALLS` is on
- **this session was not itself a callback** (see the loop guard)

Payload: `garageId`, `callerPhone`, `twilioCallSid`, `roomName`, `durationSeconds`. Fire-and-forget with a short timeout, the same shape as `post_call`, so a slow portal cannot hold a job process open.

**Why here and not in `voice.ts`.** `voice.ts` sees every inbound call and has the raw `From`, which looks like the better trigger until you read `agent.py:8167`. That block throws away a caller ID which is really the garage's *own* line: Advanced Service Centre forward their landline to us and their carrier presents the forwarding number, so ten separate callers in one day all arrived as `+441375803104`. A trigger reading raw `From` would ring the garage back ten times. The agent has already cleaned the number by the time it shuts down, and reusing that work is the whole reason the trigger lives there.

### 2. The backend decides whether to dial

New endpoint `POST /api/callbacks/request`, authenticated with the existing webhook secret the agent already uses for `/api/calls`.

It refuses, in this order, recording the reason on the attempt row:

| gate | why |
|---|---|
| garage's `shortCallCallback` flag is off | opt-in, default off |
| caller number empty, withheld, or not dialable | nothing to ring |
| number matches the garage's own `twilioNumber`, `transferNumber` or `phone` | second line of defence against the forwarded-number trap above |
| `isBlockedCaller(number, garageId)` | the demo-line blocklist already exists for this |
| outside the garage's `weeklyOpeningHours` | nobody gets rung at 9pm |
| a `CallbackAttempt` for this garage+number inside 24h | one callback per number per day |
| the reported call was itself a callback | loop guard, belt to the agent's braces |
| a newer `Call` from that number in the last hour | they rang back themselves and got served; leave them alone |
| estate or per-garage daily cap reached | runaway guard |

The "rang back themselves" gate needs care. It matches on `Call.fromNumber`, which has **no index** — the `Call` table carries only a primary key, so every garage and date filter already seq-scans it, and aggregate scans of it have OOM'd this Postgres before. Add `@@index([fromNumber, createdAt])` as part of this work, and bound the query to the last hour. Note also that the gate can only see calls that were *logged*: a sub-30s call from the same number leaves no `Call` row, but that call generates its own callback request and the 24h dedupe above catches it, so the two gates cover each other.

All of this lives in one place on purpose. Spread across seven agent flavours it would drift, which is the lesson from the WhatsApp sender's safety rules.

On a pass: record the attempt, wait 60 seconds, then dial. The delay is there because a caller who was cut off often redials immediately; ringing them while they are mid-call to us just hits an engaged tone and burns the one attempt.

### 3. The dial

New `backend/src/services/callbackDial.ts`, modelled on `unifiedSip.ts`:

1. Room name `garage-<garageId>_<caller>_cb<rand>` — verified against `_ROOM_GARAGE_RE` and `_ROOM_PHONE_RE` (`agent.py:419`, `agent.py:431`): both still match, because the `_cb` marker falls after the phone number they capture. The portal's own two-format `roomName` parsing is unaffected for the same reason.
2. Dispatch `unified-agent` by name via `RoomConfiguration` + `RoomAgentDispatch`. Without this the room is created and no worker joins — the agent is a named agent. Same trap `unifiedSip.ts` documents.
3. Job metadata `{"callback": true, "to": "+44..."}`.
4. `createSipParticipant` with `sipTrunkId` from `LIVEKIT_SIP_OUTBOUND_TRUNK`, `sipCallTo` the caller, and `sipNumber` the caller ID to present.

The trunk and env var already exist and are used in production for warm transfers (`agent.py:6491`).

**Caller ID.** The presented number is set per call, provided the outbound trunk's `numbers` is `"*"` — confirmed in LiveKit's outbound-trunk docs. The docs call the field `sip_number`, which is the protobuf name; the Node SDK we use calls it **`fromNumber`** (`livekit-server-sdk/dist/SipClient.d.ts:100`). Preference order: the garage's `outboundCallerId` when `outboundCallerIdVerified`, else the garage's `twilioNumber`. Only 2 of 63 garages are currently verified, so most callbacks would present the ReceptionMate number until the verification campaign catches up; the self-serve flow for that already exists at `POST /api/outbound-calls/caller-id/start`.

**Open question, resolved by test not by reading.** Whether Twilio accepts a non-Twilio verified caller ID as the `From` over an elastic SIP trunk. LiveKit will send what it is told; Twilio may rewrite or reject it. One real call on ReceptionMate Branch settles it. If Twilio refuses, fall back to presenting the garage's `twilioNumber` and reconsider originating through the Twilio Voice API instead (the mechanism the existing click-to-call already proves), which costs an extra hop.

### 4. Agent side

- **Detect.** `ctx.job.metadata` is already parsed in the entrypoint for the demo voice picker (`agent.py:8143`), so the flag arrives with no new plumbing. The `_cb` room-name marker is a fallback if metadata is ever lost.
- **Greet.** In `on_enter` (`agent.py:3974`), when this is a callback, replace the configured greeting with:

  > "Hi, it's {PERSONA_NAME} for {BRANCH_NAME}. We've just missed a call from you — how can I help?"

  Spoken straight to TTS exactly as the current greeting is. Routing a greeting through the LLM cold-started at ~7.6s and left callers in silence; that must not be reintroduced here. `PERSONA_NAME` and `BRANCH_NAME` are already resolved per garage by `configure_for_garage`.
- **Prompt.** One line stating the agent placed this call, so the model does not thank them for calling or ask what prompted it.
- **Caller number.** Take the dialled number from job metadata as authoritative. On an outbound call the SIP participant is the callee, so the inbound-shaped `caller_phone_from_participants` path should not be trusted to mean the same thing.
- **Loop guard, in code.** If this session is a callback, the shutdown path returns before reporting a short call. Hard return, not a prompt instruction.

### 5. The loop guard, stated plainly

A callback is itself a call, and most callbacks will be under 30 seconds — no answer, voicemail, or "no thanks, I've sorted it". Under the rule as stated, each of those would trigger another callback. The guard is enforced twice, in code both times: the agent will not report a short callback, and the backend refuses a request whose originating call was a callback. Neither relies on the model behaving.

This is the one defect in this feature capable of ringing a customer all afternoon, so it gets tests of its own.

### 6. What reaches the portal

- **Callback that works** (≥30s and the caller spoke, per the existing `_SILENCE_GUARD_BELOW` logic): goes through `call_log.post_call` unchanged and lands in the call logs like any other call. No new code — the existing rule already does what Dan asked for. Add `"callback": true` to `extra_metrics` so "did callbacks book anything?" is answerable later; that costs nothing and the portal ignores unknown metrics keys.
- **Callback that fails or runs short:** nothing to the garage, as specified.
- **Either way:** the `CallbackAttempt` row records the outcome, admin-only. Without it there is no way to tell the feature is alive, or that it has started redialling a robocaller — the shape of both the watchdog single-garage blind spot and the support-hub ingest gap.

## Data model

```prisma
model CallbackAttempt {
  id             String   @id @default(cuid())
  garageId       String
  garage         Garage   @relation(fields: [garageId], references: [id], onDelete: Cascade)
  toNumber       String                       // E.164, as dialled
  callerIdUsed   String?                      // what we presented
  originalCallSid String?                     // the short call that triggered this
  originalRoom   String?
  originalDurationSeconds Int?
  status         String   @default("pending")  // pending | dialled | answered | logged | no_answer | failed | refused
  refusedReason  String?                      // which gate said no
  resultRoom     String?                      // the callback's own room, for joining to Call
  durationSeconds Int?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  @@index([garageId, createdAt])
  @@index([toNumber, createdAt])
}
```

`refused` rows are kept rather than dropped — "why did nobody get rung back?" is the first question anyone will ask, and the gate name answers it. Both indexes are deliberate: the `Call` table has only a primary key and seq-scans on every garage/date filter, and this table will be queried exactly those two ways.

### Config flag

`shortCallCallback Boolean @default(false)` on `AgentConfiguration`, following `messagingHumanHandoff`. That precedent needs **five** touch points, and missing one fails silently:

1. `prisma/schema.prisma` — `AgentConfiguration`
2. `backend/src/utils/types.ts`
3. `backend/src/utils/validators.ts` — **the one that silently strips.** A field absent here is dropped on every save, which is how ten settings quietly reverted and FAQs were wiped to `[]`
4. `backend/src/routes/config.ts` — defaults, both GET response shapes, and the save path (four places)
5. the portal UI toggle

The flag is read by the **backend**, not the agent, so it does not need to reach DynamoDB and the broken config-sync Lambda is not in the path.

## Caps and cost

Each callback is a full agent call — LLM, TTS, STT and SIP minutes. At 89 sub-30s calls a day estate-wide, enabled everywhere with no duration floor, this is up to 89 extra outbound agent calls a day. Cost per call is driven mainly by system prompt size, and the callback uses the same prompt as a normal call.

Defaults, chosen so the ceiling is explicit rather than discovered:

| setting | default |
|---|---|
| attempts per short call | **1** — no retry; no answer means done |
| delay before dialling | **60s** |
| per number per garage | **1 per calendar day** (Europe/London) — a day bucket rather than a rolling 24h so a database unique constraint can enforce it; check-then-write races two short calls arriving together |
| per garage per day | **25** |
| estate per day | **150** |
| kill switch | `SHORT_CALL_CALLBACK_ENABLED=0` disables all dialling, flags notwithstanding |

All five are tunable; the caps are runaway guards, not a policy statement. They sit above the observed volume so that hitting one means something has gone wrong.

## Known gaps

- **Callers who ring off before the agent session starts** produce no shutdown and no report, so they are never called back. These are predominantly the ≤5s hangups, which is the population least worth ringing. Closing it needs a second trigger in `voice.ts` and the forwarded-number problem solved there too; not in this build.
- **Callers who abandon during the garage's own ringing** never reach us at all. Call forwarding diverts after 5–7 rings, so anyone who gives up before that is invisible to Twilio and to us. Nothing can be built to catch them.
- **Withheld numbers** cannot be called back. No fix.

## Compliance

An automated outbound call presenting a garage's number is a different regulatory object from answering an inbound one, even when the call is arguably solicited by the customer's own missed call. Ofcom's rules on automated calling and silent/abandoned calls, and PECR consent, want checking before this is switched on beyond ReceptionMate Branch. Flagging it as a question for Dan to confirm, not asserting what the answer is.

## Testing

1. **Unit tests on the policy gates.** Pure functions, no audio needed. The loop guard and the garage's-own-number guard are the two that must not regress.
2. **`lk agent simulate`** against the deployed unified agent for the greeting and prompt behaviour — the voice agent's regression check. Note the suite needs a real `LIVEKIT_API_KEY` or tests error and read as failures.
3. **One real call on ReceptionMate Branch** to settle the Twilio `From` question. ReceptionMate Branch is the only garage any test traffic goes to.

## Rollout

1. Schema + migration, additive.
2. Backend endpoint, policy, dial service, behind the kill switch, flag off everywhere.
3. Agent changes, deployed via git push to `danny901233/receptionmate-agents`.
4. Enable on ReceptionMate Branch; make the test call; confirm caller ID.
5. Read the `CallbackAttempt` rows for a week before enabling a second garage.
