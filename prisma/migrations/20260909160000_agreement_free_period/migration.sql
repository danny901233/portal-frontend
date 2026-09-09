-- The free period an agreement was sold with. Both values were computed by the onboarding modal
-- and posted on every draft, but no column existed and nothing read them — so the template's
-- hard-coded "14-day free trial" appeared on agreements sold without one.
-- Null means no free period: the trial clauses are omitted rather than reworded.
ALTER TABLE "Agreement" ADD COLUMN IF NOT EXISTS "freeTrialDays" INTEGER;
ALTER TABLE "Agreement" ADD COLUMN IF NOT EXISTS "freeUntilBookings" INTEGER;
