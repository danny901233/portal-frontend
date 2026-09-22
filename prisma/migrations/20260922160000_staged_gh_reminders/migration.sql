-- Staged Garage Hive reminders, each stage with its own template.
--
-- Before this the daily run sent one message at reminderDaysAhead and never followed up: the
-- campaign it created defaulted to campaignType 'oneoff', which the staged sweep deliberately
-- excludes, and its contacts carried no dueDate for the sweep to count down from.
ALTER TABLE "GarageHiveConnection" ADD COLUMN IF NOT EXISTS "reminderSchedule" JSONB;
ALTER TABLE "OutboundCampaign"     ADD COLUMN IF NOT EXISTS "stageTemplates"   JSONB;
