-- Add columns for registration and confirmed booking metadata
ALTER TABLE "Call" ADD COLUMN "registrationNumber" TEXT;
ALTER TABLE "Call" ADD COLUMN "confirmedBooking" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "Call" ADD COLUMN "confirmedBookingCategory" TEXT;
