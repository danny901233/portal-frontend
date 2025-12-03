ALTER TABLE "AgentConfiguration"
  ADD COLUMN "integrationProvider" TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN "integrationProviderConfig" JSONB;
