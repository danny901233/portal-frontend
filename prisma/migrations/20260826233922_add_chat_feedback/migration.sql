-- Garage-side rating of an AI conversation. Mirrors CallFeedback so the weekly
-- negative-feedback audit process can classify calls and messages with the same
-- buckets. Additive only (new table).

CREATE TABLE "ChatFeedback" (
  "id"             TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "rating"         TEXT NOT NULL,
  "reasons"        TEXT[] DEFAULT ARRAY[]::TEXT[],
  "notes"          TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ChatFeedback_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ChatFeedback_conversationId_key" ON "ChatFeedback"("conversationId");

ALTER TABLE "ChatFeedback"
  ADD CONSTRAINT "ChatFeedback_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "ChatConversation"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
