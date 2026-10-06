-- Staff-side translation for non-English customer threads.
--
-- A UK garage with Polish-speaking WhatsApp customers gets a thread its front desk cannot read.
-- `content` stays the record of what went over the wire; the translation sits alongside it.
ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "translatedContent" TEXT;
ALTER TABLE "ChatMessage" ADD COLUMN IF NOT EXISTS "translatedFrom" TEXT;

-- English NAME of the language the customer writes in ("Polish"), detected once from their
-- first inbound message. NULL means "not detected" and behaves as English.
ALTER TABLE "ChatConversation" ADD COLUMN IF NOT EXISTS "customerLanguage" TEXT;
