-- AlterTable: Add agentType field to AgentConfiguration
ALTER TABLE "AgentConfiguration" ADD COLUMN "agentType" TEXT NOT NULL DEFAULT 'assist';
