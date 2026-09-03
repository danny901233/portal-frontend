-- Support hub Phase 1 additions on top of Phase 2's ticket schema.
-- All additive; safe to apply on live DB.

-- 1. Free-form metadata on TicketEntry — AI classification confidence + model
--    on drafts, sent RFC5322 headers on outbound entries.
ALTER TABLE "TicketEntry" ADD COLUMN "meta" JSONB;

-- 2. Audit + dedup for Mailgun inbound POSTs. Written before parsing so we
--    never lose an email to a parser bug; unique messageId is the dedup guard
--    that keeps Mailgun's retry logic from creating duplicate tickets.
CREATE TABLE "MailgunInboundEvent" (
  "id"         TEXT NOT NULL,
  "messageId"  TEXT,
  "rawPayload" JSONB NOT NULL,
  "ticketId"   TEXT,
  "status"     TEXT NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MailgunInboundEvent_pkey" PRIMARY KEY ("id")
);

-- Unique so a retried POST for the same message-id is dropped at insert time.
-- Nullable column (Postgres treats each NULL as distinct) so events without
-- any Message-Id header still record without conflicting.
CREATE UNIQUE INDEX "MailgunInboundEvent_messageId_key"
  ON "MailgunInboundEvent" ("messageId");

CREATE INDEX "MailgunInboundEvent_receivedAt_idx"
  ON "MailgunInboundEvent" ("receivedAt");

CREATE INDEX "MailgunInboundEvent_ticketId_idx"
  ON "MailgunInboundEvent" ("ticketId");
