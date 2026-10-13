-- How a job number was arrived at.
--
-- Two routes produce one column, and they are not equally trustworthy:
--   'matched'  — tied to a real jobsheet via registration + appointment date (the nightly sweep),
--                or the one-off online-booking recovery. Exact.
--   'inferred' — the job had already been posted, so the jobsheet was gone and the link was
--                reconstructed as "this customer's first unclaimed invoice within 45 days of the
--                call". Verified by hand at line level on a sample, but still a guess.
--
-- Without this they are indistinguishable once written, and in three months nobody could say
-- which rows were inference — so a revenue figure could never be caveated or re-derived.
ALTER TABLE "Call"             ADD COLUMN "diaryJobSource" TEXT;
ALTER TABLE "ChatConversation" ADD COLUMN "diaryJobSource" TEXT;

-- The job numbers already written came from the online-booking recovery, which read them off
-- real open jobsheets.
UPDATE "Call" SET "diaryJobSource" = 'matched' WHERE "diaryJobNumber" IS NOT NULL;
