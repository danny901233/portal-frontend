-- Hard account lock (staff-applied). Purely additive: two nullable columns on "User".
-- lockedAt set = the user cannot log in, reset their password, or use a magic link.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lockedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lockedReason" TEXT;
