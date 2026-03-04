-- AlterTable
ALTER TABLE "AgentConfiguration"
  ADD COLUMN "responseSpeed" TEXT NOT NULL DEFAULT 'normal',
  ADD COLUMN "interruptionSensitivity" DOUBLE PRECISION NOT NULL DEFAULT 0.5;
