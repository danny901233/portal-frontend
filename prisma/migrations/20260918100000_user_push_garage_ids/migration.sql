-- Per-user push filter. Empty array = every garage the user can see (the previous behaviour).
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "pushGarageIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
