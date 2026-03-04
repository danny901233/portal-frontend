-- AlterTable
ALTER TABLE "User" ADD COLUMN "setupWizardCompleted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "setupWizardCompletedAt" TIMESTAMP(3);
