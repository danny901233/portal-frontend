-- The emailed URL becomes the garage's own name plus a short suffix
-- ("binley-woods-service-centre-9f3a") instead of an opaque token: the link is the pitch, so a
-- prospect should be able to see it is theirs before clicking. The suffix stops the URL being
-- guessable — a first visit BUILDS the agent, so each guess would spend a scrape and an OpenAI
-- call, and a 200 against a 404 would enumerate the prospect list.
ALTER TABLE "DemoProspect" ADD COLUMN IF NOT EXISTS "slug" TEXT;

-- Backfill any existing rows so the NOT NULL below cannot fail. Dev-only rows at this point.
UPDATE "DemoProspect" SET "slug" = "token" WHERE "slug" IS NULL;

ALTER TABLE "DemoProspect" ALTER COLUMN "slug" SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "DemoProspect_slug_unique" ON "DemoProspect"("slug");

ALTER TABLE "DemoProspect" DROP COLUMN IF EXISTS "token";

-- Set once, when we email them the summary of their own call. The follow-up is persuasive the
-- first time and spam by the third.
ALTER TABLE "DemoProspect" ADD COLUMN IF NOT EXISTS "summaryEmailedAt" TIMESTAMP(3);
