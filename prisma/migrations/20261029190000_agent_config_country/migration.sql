-- Which country's registration and postcode formats the voice agent uses.
--
-- GB for every garage but IC Garage LTD (Naas, Co. Kildare), the first Republic of Ireland
-- garage on the estate. NOT NULL with a GB default on purpose: every existing row is correct
-- the moment this lands, so there is no backfill and no window where a British garage has no
-- country. The agent reads a blank as GB too, so the two agree even if they disagree.
ALTER TABLE "AgentConfiguration" ADD COLUMN "country" TEXT NOT NULL DEFAULT 'GB';
