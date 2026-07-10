-- Arrears / access gating flag. When true, the garage's own users see only date+tag for
-- their calls (name/number/summary/transcript/recording withheld) and get an arrears email
-- per call. Internal RECEPTIONMATE_STAFF are unaffected. Additive, non-blocking.
ALTER TABLE "Garage" ADD COLUMN IF NOT EXISTS "accessRestricted" BOOLEAN NOT NULL DEFAULT false;
