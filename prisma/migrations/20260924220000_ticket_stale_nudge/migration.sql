-- One nudge per silence on a pending ticket; cleared when the customer replies.
ALTER TABLE "Ticket" ADD COLUMN IF NOT EXISTS "staleNudgedAt" TIMESTAMP(3);
