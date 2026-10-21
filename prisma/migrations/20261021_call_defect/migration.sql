-- Findings from the call defect scanner, read by /observability.
-- Derived data: dropping this table loses nothing a rescan cannot rebuild.
CREATE TABLE IF NOT EXISTS "CallDefect" (
  "id" TEXT NOT NULL,
  "callId" TEXT NOT NULL,
  "garageId" TEXT NOT NULL,
  "signature" TEXT NOT NULL,
  "severity" TEXT NOT NULL,
  "detail" TEXT NOT NULL,
  "callAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CallDefect_pkey" PRIMARY KEY ("id")
);

-- One row per signature per call, so the scanner can rescan an overlapping
-- window without duplicating what it already found.
CREATE UNIQUE INDEX IF NOT EXISTS "CallDefect_callId_signature_key" ON "CallDefect"("callId", "signature");
CREATE INDEX IF NOT EXISTS "CallDefect_callAt_idx" ON "CallDefect"("callAt");
CREATE INDEX IF NOT EXISTS "CallDefect_garageId_callAt_idx" ON "CallDefect"("garageId", "callAt");
CREATE INDEX IF NOT EXISTS "CallDefect_signature_callAt_idx" ON "CallDefect"("signature", "callAt");
