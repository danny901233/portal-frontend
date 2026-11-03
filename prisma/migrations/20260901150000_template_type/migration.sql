-- What a WhatsApp template is FOR, separate from Meta's billing `category`.
--
-- Outbound campaigns and the chat agent both need to know whether a reminder is about a service,
-- an MOT, deferred work or a promotion. It was being inferred from the template name with a
-- regex; an explicit field replaces that.
--
-- Nullable on purpose: existing templates keep working and fall back to the date-based rule.
ALTER TABLE "MessageTemplate" ADD COLUMN "templateType" TEXT;

-- Backfill from the names we already have, using the same one-and-not-the-other test the code
-- used, so today's behaviour is preserved rather than silently changed.
UPDATE "MessageTemplate"
   SET "templateType" = 'service'
 WHERE lower(name) LIKE '%service%' AND lower(name) NOT LIKE '%mot%';

UPDATE "MessageTemplate"
   SET "templateType" = 'mot'
 WHERE lower(name) ~ '(^|_)mot(_|$)' AND lower(name) NOT LIKE '%service%';
