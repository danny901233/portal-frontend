-- Arrears timer for Stripe card customers: set on a failed charge, cleared on success.
ALTER TABLE "Garage" ADD COLUMN IF NOT EXISTS "paymentFailedAt" TIMESTAMP(3);
