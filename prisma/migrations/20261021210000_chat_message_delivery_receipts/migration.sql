-- Meta delivery receipts for outbound chat replies.
-- Additive and nullable: existing rows keep working and read as "no receipt recorded",
-- which is the truth for every message sent before this shipped.
ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "deliveryStatus" TEXT;
ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "deliveredAt" TIMESTAMP(3);
ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "readAt" TIMESTAMP(3);
ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "failedReason" TEXT;

-- CONCURRENTLY so the table is not locked out while this builds on a live box.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChatMessage_deliveryStatus_idx"
  ON "ChatMessage"("deliveryStatus");
