-- Garage-side Messages inbox: per-conversation assignment + auto-derived
-- enquiry category. Additive only (nullable columns + FK w/ SetNull) so
-- existing rows and any concurrent traffic are unaffected.

ALTER TABLE "ChatConversation"
  ADD COLUMN "enquiryType" TEXT,
  ADD COLUMN "assigneeId" TEXT;

-- If the owning user loses garage access and is removed, drop the conversation
-- back into the unassigned pool rather than orphaning it.
ALTER TABLE "ChatConversation"
  ADD CONSTRAINT "ChatConversation_assigneeId_fkey"
  FOREIGN KEY ("assigneeId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "ChatConversation_garageId_assigneeId_idx"
  ON "ChatConversation" ("garageId", "assigneeId");

CREATE INDEX "ChatConversation_garageId_enquiryType_idx"
  ON "ChatConversation" ("garageId", "enquiryType");
