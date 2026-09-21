-- Screening rings its own number, not the mid-call transfer number.
ALTER TABLE "AgentConfiguration" ADD COLUMN IF NOT EXISTS "screenNumber" TEXT;
-- Carry over the one garage already screening, which was using transferNumber.
UPDATE "AgentConfiguration" SET "screenNumber" = "transferNumber"
  WHERE "screenBeforeAgent" = true AND "screenNumber" IS NULL;
