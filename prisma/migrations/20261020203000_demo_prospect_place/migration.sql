-- The agent's prompt is handed "- address: …" and "- email: …" straight from this config. With no
-- address it had no answer at all when a prospect asked where they were based, and the email it
-- did have was ours (the summary destination), which it then read out as the garage's own.
--
-- placeId is carried over from the shortlist enrichment so the address and phone can be fetched
-- from Google once and cached, instead of being re-billed on every build.
ALTER TABLE "DemoProspect" ADD COLUMN IF NOT EXISTS "placeId" TEXT;
ALTER TABLE "DemoProspect" ADD COLUMN IF NOT EXISTS "branchAddress" TEXT;
ALTER TABLE "DemoProspect" ADD COLUMN IF NOT EXISTS "phoneNumber" TEXT;
