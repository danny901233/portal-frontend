-- Chasing a customer for a reply becomes opt-in: it is only right when we are
-- actually waiting on an answer, which answering their question is not.
ALTER TABLE "Ticket" ALTER COLUMN "autoChase" SET DEFAULT false;

-- Nothing currently open gets chased on the old assumption. Anyone genuinely
-- waiting on an answer can re-arm it from the reply box.
UPDATE "Ticket" SET "autoChase" = false WHERE status IN ('new', 'open', 'pending');
