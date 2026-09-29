-- One invoice per business (branches as sections) instead of one per branch.
-- Default false: existing customers keep the per-branch invoices they have today.
ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "combinedInvoicing" BOOLEAN NOT NULL DEFAULT false;
