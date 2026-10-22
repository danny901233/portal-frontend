-- Notes and "actioned" state for the faults listed on /observability.
--
-- A separate table on purpose: the scanner rewrites a call's CallDefect rows on every rescan,
-- so anything stored on those rows would be wiped within 15 minutes of being written.
CREATE TABLE IF NOT EXISTS "CallDefectNote" (
  "id" TEXT NOT NULL,
  "callId" TEXT NOT NULL,
  "signature" TEXT NOT NULL,
  "note" TEXT,
  "actionedAt" TIMESTAMP(3),
  "actionedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CallDefectNote_pkey" PRIMARY KEY ("id")
);

-- One note per fault per call, so a rescan reattaches to the same row.
CREATE UNIQUE INDEX IF NOT EXISTS "CallDefectNote_callId_signature_key"
  ON "CallDefectNote"("callId", "signature");
CREATE INDEX IF NOT EXISTS "CallDefectNote_actionedAt_idx" ON "CallDefectNote"("actionedAt");
