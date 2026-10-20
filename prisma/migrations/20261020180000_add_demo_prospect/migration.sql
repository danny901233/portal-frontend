-- Cold prospects emailed a personal link to hear an agent answering as their own garage.
-- Deliberately NOT rows in "Garage": the agent reads its runtime config from the AgentConfig
-- DynamoDB table keyed on "agentId", so a prospect never appears in the garage pickers,
-- dashboards, billing, the arrears sweep or the watchdog's routing audit.
CREATE TABLE IF NOT EXISTS "DemoProspect" (
    "id"           TEXT NOT NULL,
    "token"        TEXT NOT NULL,
    "code"         TEXT NOT NULL,
    "agentId"      TEXT NOT NULL,
    "businessName" TEXT NOT NULL,
    "spokenName"   TEXT NOT NULL,
    "websiteUrl"   TEXT,
    "email"        TEXT,
    "contactId"    TEXT,
    "builtAt"      TIMESTAMP(3),
    "lastCalledAt" TIMESTAMP(3),
    "callCount"    INTEGER NOT NULL DEFAULT 0,
    "expiresAt"    TIMESTAMP(3) NOT NULL,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DemoProspect_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "DemoProspect_token_unique"   ON "DemoProspect"("token");
CREATE UNIQUE INDEX IF NOT EXISTS "DemoProspect_code_unique"    ON "DemoProspect"("code");
CREATE UNIQUE INDEX IF NOT EXISTS "DemoProspect_agentId_unique" ON "DemoProspect"("agentId");
CREATE INDEX IF NOT EXISTS "DemoProspect_expiresAt_idx"         ON "DemoProspect"("expiresAt");
