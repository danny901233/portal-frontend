-- Add optional Twilio number to Garage records for managed routing
ALTER TABLE "Garage" ADD COLUMN IF NOT EXISTS "twilioNumber" TEXT;
