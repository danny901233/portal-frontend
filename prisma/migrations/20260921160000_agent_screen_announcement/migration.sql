-- What the screened phone hears before the keypress.
ALTER TABLE "AgentConfiguration" ADD COLUMN IF NOT EXISTS "screenAnnouncement" TEXT;
