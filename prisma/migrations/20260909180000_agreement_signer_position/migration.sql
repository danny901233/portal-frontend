-- The signer's position was captured at signing and written into templateSnapshot, but never
-- stored as a column, so a PDF regenerated later had no position to place under the name.
ALTER TABLE "Agreement" ADD COLUMN IF NOT EXISTS "signedByPosition" TEXT;
