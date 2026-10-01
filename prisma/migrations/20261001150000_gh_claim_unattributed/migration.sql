-- One branch of a shared Garage Hive company may take the vehicles that cannot be attributed to
-- any branch (no job and no health check anywhere in the group). Off everywhere by default: the
-- safe behaviour is to message nobody rather than message on another branch's behalf.
ALTER TABLE "GarageHiveConnection"
  ADD COLUMN IF NOT EXISTS "claimUnattributed" BOOLEAN NOT NULL DEFAULT false;
