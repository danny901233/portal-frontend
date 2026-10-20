-- The garage's real opening hours, parsed from their own website before any link goes out.
-- Resolved ahead of time rather than at click time: the agent states hours as fact, so a wrong
-- parse has to be reviewable in a spreadsheet instead of first being heard by the prospect.
-- NULL means we do not know them, and the agent is then built so it does not claim to.
ALTER TABLE "DemoProspect" ADD COLUMN IF NOT EXISTS "weeklyOpeningHours" JSONB;
ALTER TABLE "DemoProspect" ADD COLUMN IF NOT EXISTS "hoursSource" TEXT;
