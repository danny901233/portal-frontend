-- Every chat conversation gets a summary email, like every call does. This column records that it
-- was sent, and is what keeps the ten-minute sweep from sending a second one.
ALTER TABLE "ChatConversation" ADD COLUMN IF NOT EXISTS "summaryEmailSentAt" TIMESTAMP(3);

-- The sweep's query: unsummarised conversations, oldest activity first.
CREATE INDEX IF NOT EXISTS "ChatConversation_summaryEmailSentAt_lastMessageAt_idx"
  ON "ChatConversation" ("summaryEmailSentAt", "lastMessageAt");
