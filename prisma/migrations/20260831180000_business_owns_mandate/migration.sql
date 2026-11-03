-- The Direct Debit mandate belongs to the business, not to the individual who signed up.
--
-- Business already carried gocardlessMandateId/gocardlessCustomerId, but they were never
-- declared in the Prisma schema and nothing has read or written them since roughly July —
-- an abandoned half-migration. They have since gone stale: two businesses hold a mandate
-- that GoCardless reports as CANCELLED while the payer's User row holds the live one
-- (Caldwell and Dempster, Cairneys — both replaced their mandate on 17 Aug and only the
-- User copy was updated, because payment.ts writes User alone).
--
-- So this does not backfill an empty column, it re-syncs a misleading one. User is the live
-- source of truth today and stays that way for billing; Business becomes a faithful mirror
-- of it, plus the new flag, and the write paths are changed in the same commit so the two
-- cannot drift apart again.
--
-- Hand-written rather than generated: this database carries drift the auto-migrator refuses
-- to work around (GH #357).

ALTER TABLE "Business"
  ADD COLUMN "mustSetupPayment" BOOLEAN NOT NULL DEFAULT false;

-- Mirror the payer's mandate onto the business. Verified beforehand that every mandate
-- holder maps to exactly one business and no business has two holders, so there is no
-- arbitrary winner to pick.
UPDATE "Business" b
   SET "gocardlessMandateId"  = p."gocardlessMandateId",
       "gocardlessCustomerId" = p."gocardlessCustomerId"
  FROM (
    SELECT DISTINCT g."businessId" AS business_id,
           u."gocardlessMandateId",
           u."gocardlessCustomerId"
      FROM "User" u
      JOIN "Garage" g ON g.id = ANY(u."garageAccessIds") AND g."archivedAt" IS NULL
     WHERE u."gocardlessMandateId" IS NOT NULL
       AND g."businessId" IS NOT NULL
  ) p
 WHERE b.id = p.business_id
   AND b."gocardlessMandateId" IS DISTINCT FROM p."gocardlessMandateId";

-- Clear the mandate on any business whose payer no longer holds one. These are five churned
-- accounts (no live garages, no revenue) and EAC Telford, whose mandate was cancelled at
-- their bank on 17 August. Leaving a cancelled id here is what made this column dangerous.
UPDATE "Business" b
   SET "gocardlessMandateId"  = NULL,
       "gocardlessCustomerId" = NULL
 WHERE b."gocardlessMandateId" IS NOT NULL
   AND NOT EXISTS (
     SELECT 1
       FROM "User" u
       JOIN "Garage" g ON g.id = ANY(u."garageAccessIds") AND g."archivedAt" IS NULL
      WHERE g."businessId" = b.id
        AND u."gocardlessMandateId" IS NOT NULL
   );

-- Carry the existing prompt across, so nobody is newly nagged and nobody stops being asked.
-- An explicit flag rather than "has no mandate": trial and not-yet-onboarded businesses also
-- have no mandate and must not be chased for one.
--
-- Gated on the business having no mandate, which the per-user flag was not. RPM Malvern and
-- St Johns each have a colleague carrying mustSetupPayment from an invite they never
-- finished, while the business itself pays perfectly well. Promoting that to the business
-- would ask an already-paying customer to authorise a SECOND mandate — and billing bills
-- every mandate it finds, so that is a double-charge waiting to happen.
UPDATE "Business" b
   SET "mustSetupPayment" = true
 WHERE b."gocardlessMandateId" IS NULL
   AND EXISTS (
   SELECT 1
     FROM "User" u
     JOIN "Garage" g ON g.id = ANY(u."garageAccessIds") AND g."archivedAt" IS NULL
    WHERE g."businessId" = b.id
      AND u."mustSetupPayment"
 );

CREATE INDEX IF NOT EXISTS "Business_gocardlessMandateId_idx" ON "Business"("gocardlessMandateId");
