-- Sales-led onboarding pipeline fields.
--
-- Recovered alongside routes/onboarding-pipeline.ts and utils/onboardingStage.ts, whose source
-- was lost in August. The code read these columns; they were never in schema.prisma or the
-- database, so the pipeline would have thrown even before its routes stopped being mounted.
--
-- Purely additive and idempotent. onboardingStage defaults to 'live' ON PURPOSE: every garage
-- that already exists is already onboarded, and any other default would drag the whole estate
-- into the pipeline the moment this lands.
ALTER TABLE "Garage" ADD COLUMN IF NOT EXISTS "onboardingStage" TEXT NOT NULL DEFAULT 'live';
ALTER TABLE "Garage" ADD COLUMN IF NOT EXISTS "onboardingStageAt" JSONB;

-- What staff chase an agreement on: when it went out, to whom, and whether it has been opened.
ALTER TABLE "Agreement" ADD COLUMN IF NOT EXISTS "sentAt" TIMESTAMP(3);
ALTER TABLE "Agreement" ADD COLUMN IF NOT EXISTS "sentToEmail" TEXT;
ALTER TABLE "Agreement" ADD COLUMN IF NOT EXISTS "firstViewedAt" TIMESTAMP(3);
ALTER TABLE "Agreement" ADD COLUMN IF NOT EXISTS "lastViewedAt" TIMESTAMP(3);
ALTER TABLE "Agreement" ADD COLUMN IF NOT EXISTS "viewCount" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "Garage_onboardingStage_idx" ON "Garage"("onboardingStage");
