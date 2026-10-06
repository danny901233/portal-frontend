-- Allow a garage to keep an old WhatsApp number connected alongside its current one, so customers
-- who still have the old number are answered instead of silently ignored. Inbound routes by
-- whatsappPhoneNumberId; isPrimary settles which number OUTBOUND sends from.
ALTER TABLE "SocialMediaConnection"
  ADD COLUMN IF NOT EXISTS "isPrimary" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "SocialMediaConnection"
  DROP CONSTRAINT IF EXISTS "SocialMediaConnection_garageId_platform_key";

CREATE INDEX IF NOT EXISTS "SocialMediaConnection_garageId_platform_isPrimary_idx"
  ON "SocialMediaConnection" ("garageId", "platform", "isPrimary");

-- Prisma's @@unique landed as a unique INDEX, not a table constraint, so DROP CONSTRAINT above
-- silently skipped it and the uniqueness was still enforced. Drop the index by name as well.
DROP INDEX IF EXISTS "SocialMediaConnection_garageId_platform_key";
