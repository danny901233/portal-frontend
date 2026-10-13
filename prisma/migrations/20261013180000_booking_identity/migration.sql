-- Booking identity: tie a booking we placed to what the garage actually invoiced.
--
-- bookingDetails is free prose, so the only way to value our bookings was to guess which of a
-- customer's invoices was ours (reg -> vehicle -> customer -> "an invoice within 45 days"). That
-- over-read Speedy Spanners by £1,795 on 65 bookings by double-counting repeat customers.
--
-- diaryJobNumber is the fix: in Business Central a posted invoice carries the SAME number as the
-- jobsheet it came from ("SJ000829"), so once we know the job number the invoiced value is exact.
-- It is resolved after the fact (the booking API never returns it) from bookingAt + registration.
ALTER TABLE "Call"
  ADD COLUMN "bookingReference" TEXT,
  ADD COLUMN "bookingAt"        TIMESTAMP(3),
  ADD COLUMN "diaryJobNumber"   TEXT;

ALTER TABLE "ChatConversation"
  ADD COLUMN "bookingReference" TEXT,
  ADD COLUMN "bookingAt"        TIMESTAMP(3),
  ADD COLUMN "diaryJobNumber"   TEXT;

-- The sweep's own query: "bookings that still need a job number". Without an index it is a full
-- scan of Call, and this database OOMs on those.
CREATE INDEX "Call_garageId_bookingAt_idx" ON "Call" ("garageId", "bookingAt");
CREATE INDEX "ChatConversation_garageId_bookingAt_idx" ON "ChatConversation" ("garageId", "bookingAt");

-- Crediting hand-booked work to the call that asked for it. OFF by default: on a garage whose
-- agent does book, a message carrying a date is usually a booking that FAILED, and counting those
-- would mix "we booked it" with "they might have booked it" in one revenue figure.
ALTER TABLE "GarageHiveConnection"
  ADD COLUMN "attributeCallbackBookings" BOOLEAN NOT NULL DEFAULT false;

-- Enabled for the JDK group only. These three are one Business Central company split by
-- locationCode (Ecotest / Great Hollands / JDK Camberley), and they are the garages that take no
-- bookings at all — so scoping by the company is both exact and self-documenting.
UPDATE "GarageHiveConnection"
   SET "attributeCallbackBookings" = true
 WHERE "companyId" = '96269348-2a33-ef11-8409-00224807b512';
