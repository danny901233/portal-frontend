-- What a booking actually invoiced for.
--
-- diaryJobNumber identifies the garage's job; this is what that job was worth. In Business Central
-- a posted sales invoice carries the SAME number as the jobsheet it came from, so no new matching
-- is needed — the number IS the lookup key.
--
-- EX VAT, because that is the garage's revenue and the basis every figure quoted so far uses.
-- invoiceStatus is kept as BC's own word (Draft | Open | Paid | Corrective | Canceled) rather than
-- collapsed to a boolean, so a dashboard can keep a Draft out of a revenue total without a second
-- read of the API.
ALTER TABLE "Call"
  ADD COLUMN "invoicedValue"  DOUBLE PRECISION,
  ADD COLUMN "invoicedAt"     TIMESTAMP(3),
  ADD COLUMN "invoiceStatus"  TEXT;

ALTER TABLE "ChatConversation"
  ADD COLUMN "invoicedValue"  DOUBLE PRECISION,
  ADD COLUMN "invoicedAt"     TIMESTAMP(3),
  ADD COLUMN "invoiceStatus"  TEXT;

-- The sweep's second pass: "which resolved jobs still have no invoice?". Partial, because the rows
-- it wants are the small minority with a job number, and this database OOMs on full scans of Call.
CREATE INDEX "Call_diaryJobNumber_idx" ON "Call" ("diaryJobNumber") WHERE "diaryJobNumber" IS NOT NULL;
