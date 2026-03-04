-- AlterTable
ALTER TABLE "AgentConfiguration" ADD COLUMN "weeklyOpeningHours_new" JSONB;

-- Transfer any existing opening hour notes into the new column as NULL
UPDATE "AgentConfiguration"
SET "weeklyOpeningHours_new" = NULL
WHERE "weeklyOpeningHours" IS NOT NULL;

ALTER TABLE "AgentConfiguration" DROP COLUMN "weeklyOpeningHours";

ALTER TABLE "AgentConfiguration" RENAME COLUMN "weeklyOpeningHours_new" TO "weeklyOpeningHours";
