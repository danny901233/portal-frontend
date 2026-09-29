-- Retire 'solved'. It never behaved differently from 'closed' — a customer
-- reply reopened both — and it was the one finished state that left the
-- original email sitting in the inbox.
UPDATE "Ticket"
   SET status    = 'closed',
       "closedAt" = COALESCE("closedAt", "solvedAt", now())
 WHERE status = 'solved';
