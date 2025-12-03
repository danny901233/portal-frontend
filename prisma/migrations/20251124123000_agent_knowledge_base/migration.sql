-- CreateTable
CREATE TABLE "AgentKnowledgeDocument" (
    "id" TEXT NOT NULL,
    "garageId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "title" TEXT,
    "url" TEXT,
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentKnowledgeDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentKnowledgeDocument_garageId_idx" ON "AgentKnowledgeDocument"("garageId");
CREATE INDEX "AgentKnowledgeDocument_garageId_source_idx" ON "AgentKnowledgeDocument"("garageId", "source");

-- AddForeignKey
ALTER TABLE "AgentKnowledgeDocument" ADD CONSTRAINT "AgentKnowledgeDocument_garageId_fkey" FOREIGN KEY ("garageId") REFERENCES "Garage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
