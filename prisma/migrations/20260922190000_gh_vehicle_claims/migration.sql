-- A branch claiming a vehicle Garage Hive cannot attribute.
--
-- One vehicle, one owning branch: the unique index is what stops two branches in the same
-- Business Central company both claiming a customer and both messaging them.
CREATE TABLE IF NOT EXISTS "GarageHiveVehicleClaim" (
  "id"             TEXT NOT NULL,
  "companyId"      TEXT NOT NULL,
  "registration"   TEXT NOT NULL,
  "locationCode"   TEXT NOT NULL,
  "garageId"       TEXT NOT NULL,
  "claimedByEmail" TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GarageHiveVehicleClaim_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "GarageHiveVehicleClaim_companyId_registration_key"
  ON "GarageHiveVehicleClaim"("companyId", "registration");
CREATE INDEX IF NOT EXISTS "GarageHiveVehicleClaim_garageId_idx"
  ON "GarageHiveVehicleClaim"("garageId");
ALTER TABLE "GarageHiveVehicleClaim"
  DROP CONSTRAINT IF EXISTS "GarageHiveVehicleClaim_garageId_fkey";
ALTER TABLE "GarageHiveVehicleClaim"
  ADD CONSTRAINT "GarageHiveVehicleClaim_garageId_fkey"
  FOREIGN KEY ("garageId") REFERENCES "Garage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
