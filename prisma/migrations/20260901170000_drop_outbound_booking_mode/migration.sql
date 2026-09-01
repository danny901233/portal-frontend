-- Drop outboundBookingMode again. Added earlier today and never used in anger.
--
-- The per-garage toggle turned out to be a second way of saying something the diary already says:
-- if a garage does not want the assistant booking, they leave no online availability, and the
-- empty-diary path already takes a preferred date and hands it to a person. One behaviour for
-- everyone, and availability stays where the garage controls it.
ALTER TABLE "AgentConfiguration" DROP COLUMN IF EXISTS "outboundBookingMode";

-- And put the JDK group back in line with every other GarageHive garage. allowBookings is read
-- only by the Bookar agent; leaving three GarageHive garages sitting at false would be a leftover
-- of the removed toggle, and misleading to whoever reads it next.
UPDATE "AgentConfiguration" ac
   SET "allowBookings" = true
  FROM "Garage" g
  JOIN "Business" b ON b.id = g."businessId"
 WHERE g.id = ac."garageId"
   AND b.name = 'JDK Automotive Limited';
