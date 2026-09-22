-- What a turn of chat costs in model calls.
CREATE TABLE IF NOT EXISTS "ChatUsage" (
  "id" TEXT NOT NULL,
  "garageId" TEXT,
  "conversationId" TEXT,
  "channel" TEXT,
  "agent" TEXT,
  "model" TEXT NOT NULL,
  "inputTokens" INTEGER NOT NULL DEFAULT 0,
  "cachedTokens" INTEGER NOT NULL DEFAULT 0,
  "outputTokens" INTEGER NOT NULL DEFAULT 0,
  "costMicroUsd" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChatUsage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ChatUsage_garageId_createdAt_idx" ON "ChatUsage"("garageId", "createdAt");
CREATE INDEX IF NOT EXISTS "ChatUsage_conversationId_idx" ON "ChatUsage"("conversationId");
CREATE INDEX IF NOT EXISTS "ChatUsage_createdAt_idx" ON "ChatUsage"("createdAt");
