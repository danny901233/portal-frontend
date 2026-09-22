-- Open/click timestamps that survive each other, and when the credentials link was opened.
ALTER TABLE "EmailLog" ADD COLUMN IF NOT EXISTS "openedAt" TIMESTAMP(3);
ALTER TABLE "EmailLog" ADD COLUMN IF NOT EXISTS "clickedAt" TIMESTAMP(3);
ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "diaryLinkOpenedAt" TIMESTAMP(3);
