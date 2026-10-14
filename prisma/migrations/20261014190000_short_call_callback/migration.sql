-- Short-call callback: when a call ends under 30 seconds, ring the caller back.
--
-- Short calls have never reached the portal — every agent discards them below MIN_LOG_SECONDS
-- and voice.ts deletes the row if a short recording arrives — so none of this can be derived
-- from Call. The attempt is its own record.
--
-- Refusals are stored as rows rather than dropped: "why did nobody get rung back?" is the first
-- question anyone asks, and refusedReason answers it. Nothing here is garage-facing.
CREATE TABLE "CallbackAttempt" (
    "id"                      TEXT NOT NULL,
    "garageId"                TEXT NOT NULL,
    "toNumber"                TEXT NOT NULL,
    -- Day bucket in Europe/London ("2026-10-14"). Exists so the unique index below can enforce
    -- one callback per number per garage per day IN THE DATABASE. A rolling 24h window can only
    -- be done as check-then-write, which races two short calls arriving a second apart — which
    -- is exactly what happens when somebody's signal drops twice.
    "dedupeKey"               TEXT NOT NULL,
    "callerIdUsed"            TEXT,
    "originalCallSid"         TEXT,
    "originalRoom"            TEXT,
    "originalDurationSeconds" INTEGER,
    -- pending | dialled | answered | logged | no_answer | failed | refused
    "status"                  TEXT NOT NULL DEFAULT 'pending',
    "refusedReason"           TEXT,
    "resultRoom"              TEXT,
    "durationSeconds"         INTEGER,
    "dueAt"                   TIMESTAMP(3) NOT NULL,
    "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"               TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CallbackAttempt_pkey" PRIMARY KEY ("id")
);

-- The dedupe. This single constraint is what stands between two short calls arriving together
-- and two phone calls to the same person.
CREATE UNIQUE INDEX "CallbackAttempt_garageId_toNumber_dedupeKey_key"
    ON "CallbackAttempt" ("garageId", "toNumber", "dedupeKey");

CREATE INDEX "CallbackAttempt_garageId_createdAt_idx" ON "CallbackAttempt" ("garageId", "createdAt");
-- The sweep's own query: "what is pending and due?"
CREATE INDEX "CallbackAttempt_status_dueAt_idx" ON "CallbackAttempt" ("status", "dueAt");

ALTER TABLE "CallbackAttempt" ADD CONSTRAINT "CallbackAttempt_garageId_fkey"
    FOREIGN KEY ("garageId") REFERENCES "Garage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Opt-in, per garage, OFF by default: an outbound call placed in a garage's name is theirs to
-- choose, not ours to assume.
ALTER TABLE "AgentConfiguration"
  ADD COLUMN "shortCallCallback" BOOLEAN NOT NULL DEFAULT false;

-- The policy asks "has this number rung back since?", and Call otherwise carries only a primary
-- key, so that question is a sequential scan of a 295MB table.
--
-- Safe to build in hours: Call's heap is 55MB and the other 241MB is TOASTed JSON (metrics,
-- transcript) which CREATE INDEX does not read. Measured 2026-10-14.
CREATE INDEX "Call_fromNumber_createdAt_idx" ON "Call" ("fromNumber", "createdAt");
