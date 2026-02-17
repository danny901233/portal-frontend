-- AlterTable: Add agentScript field to AgentConfiguration
ALTER TABLE "AgentConfiguration" ADD COLUMN "agentScript" TEXT NOT NULL DEFAULT 'basic_agent2.py';
