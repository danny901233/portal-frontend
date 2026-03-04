-- Add mustChangePassword flag to enforce first login password reset
ALTER TABLE "User"
ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;
