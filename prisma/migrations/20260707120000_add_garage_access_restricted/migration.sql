-- Arrears/access gating flag: withholds call content + shows the payment blocker.
ALTER TABLE "Garage" ADD COLUMN IF NOT EXISTS "accessRestricted" BOOLEAN NOT NULL DEFAULT false;
