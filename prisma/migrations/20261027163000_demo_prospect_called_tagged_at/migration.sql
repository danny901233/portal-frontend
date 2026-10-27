-- When HighLevel was told this prospect rang their receptionist. Null means not yet marked.
ALTER TABLE "DemoProspect" ADD COLUMN "calledTaggedAt" TIMESTAMP(3);
