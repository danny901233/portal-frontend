-- Mobile push notifications: per-user APNs device tokens + opt-out flag
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "deviceTokens" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "pushEnabled" BOOLEAN NOT NULL DEFAULT true;
