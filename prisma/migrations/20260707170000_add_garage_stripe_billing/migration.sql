-- Stripe billing fields for NEW Assist self-serve signups (14-day trial then monthly card sub).
-- Existing GoCardless Direct Debit customers never get these set. Additive, non-blocking.
ALTER TABLE "Garage" ADD COLUMN IF NOT EXISTS "stripeCustomerId" TEXT;
ALTER TABLE "Garage" ADD COLUMN IF NOT EXISTS "stripeSubscriptionId" TEXT;
ALTER TABLE "Garage" ADD COLUMN IF NOT EXISTS "trialEndsAt" TIMESTAMP(3);
