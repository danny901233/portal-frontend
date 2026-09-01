-- How a garage wants replies to outbound reminders handled.
--
-- 'auto' keeps today's behaviour: the assistant checks availability and books. 'enquire' asks
-- what dates would suit, captures the answer, and hands it to a human to confirm — which is how
-- Great Hollands, Ecotest and JDK actually run their diaries.
--
-- Defaulted to 'auto' so every existing garage is unchanged.
ALTER TABLE "AgentConfiguration"
  ADD COLUMN "outboundBookingMode" TEXT NOT NULL DEFAULT 'auto';
