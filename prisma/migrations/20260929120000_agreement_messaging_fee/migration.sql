-- Connect priced separately from the voice licence on an agreement.
ALTER TABLE "Agreement" ADD COLUMN IF NOT EXISTS "messagingFeeGbp" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "Agreement" ADD COLUMN IF NOT EXISTS "messagingCentresCount" INTEGER;
