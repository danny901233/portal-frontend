-- Five digits a garage reads out to identify itself to the support agent when
-- calling from a number we do not hold.
ALTER TABLE "Garage" ADD COLUMN IF NOT EXISTS "supportCode" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Garage_supportCode_key" ON "Garage"("supportCode");
