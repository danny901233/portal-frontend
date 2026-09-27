-- Whether the no-reply sweep may email this person. False where we raised the
-- ticket ourselves off something they did and asked them nothing.
ALTER TABLE "Ticket" ADD COLUMN IF NOT EXISTS "autoChase" BOOLEAN NOT NULL DEFAULT true;

-- Backfill the tickets that already exist: thumbs-down feedback, and anything
-- raised from a call on our own lines.
UPDATE "Ticket" SET "autoChase" = false
 WHERE "autoChase" = true
   AND (title LIKE 'Thumbs down %' OR channel = 'phone');
