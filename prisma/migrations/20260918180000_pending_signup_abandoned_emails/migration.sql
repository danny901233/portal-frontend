-- Abandoned-checkout follow-up timestamps. Applied to production by hand when the feature
-- shipped; recorded here so a fresh database gets them too.
ALTER TABLE "PendingSignup" ADD COLUMN IF NOT EXISTS "abandonedEmail1At" TIMESTAMP(3);
ALTER TABLE "PendingSignup" ADD COLUMN IF NOT EXISTS "abandonedEmail2At" TIMESTAMP(3);
