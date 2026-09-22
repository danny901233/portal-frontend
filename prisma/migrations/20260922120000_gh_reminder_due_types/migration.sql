-- Which due-dates the daily Garage Hive reminder run chases.
--
-- Before this, a run always chased both MOT and service. For a garage whose reminders exist to
-- sell servicing that is the wrong list: MOT-due vehicles are a separate, larger population, many
-- with no service date on record at all.
--
-- The default is both, so every existing connection keeps behaving exactly as it did.
ALTER TABLE "GarageHiveConnection"
  ADD COLUMN IF NOT EXISTS "reminderDueTypes" TEXT NOT NULL DEFAULT 'mot,service';
