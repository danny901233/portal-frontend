-- AlterTable
ALTER TABLE "AgentConfiguration" ADD COLUMN     "notificationEmails" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "Call" ADD COLUMN     "emotionData" JSONB;
