-- Add setup wizard tracking to Garage model
ALTER TABLE "Garage" ADD COLUMN "setupWizardCompleted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Garage" ADD COLUMN "setupWizardCompletedAt" TIMESTAMP(3);
