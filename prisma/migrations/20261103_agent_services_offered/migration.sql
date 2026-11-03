-- The Services tab: what work a garage does, so the agent can answer "do you do timing
-- chains?" without guessing, and stop offering work the garage does not do.
--
-- servicesOffered is nullable on purpose. NULL = the garage has never answered, and the agent
-- must take a message rather than claim anything. '[]'::jsonb = it answered "none of these".
ALTER TABLE "AgentConfiguration"
  ADD COLUMN IF NOT EXISTS "servicesOffered" JSONB,
  ADD COLUMN IF NOT EXISTS "servicesCustom" TEXT[] NOT NULL DEFAULT '{}';
