-- Ring a human before the agent answers (call screening).
ALTER TABLE "AgentConfiguration"
  ADD COLUMN IF NOT EXISTS "screenBeforeAgent" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "screenRingSeconds" INTEGER NOT NULL DEFAULT 15;
