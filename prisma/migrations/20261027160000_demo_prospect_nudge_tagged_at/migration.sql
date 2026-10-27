-- When HighLevel was told a prospect built an agent and never rang it. Null means never nudged.
ALTER TABLE "DemoProspect" ADD COLUMN "nudgeTaggedAt" TIMESTAMP(3);
