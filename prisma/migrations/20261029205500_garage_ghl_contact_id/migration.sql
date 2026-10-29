-- The HighLevel CONTACT id for a garage, as opposed to the opportunity it already carries.
--
-- HighLevel notes attach to a contact. This id only ever existed on PendingSignup and was not
-- carried across when the garage was created, so an onboarding email had no contact to be noted
-- against. Nullable: most garages will not have one until it is resolved from the business's
-- contact phone on the first onboarding email, and a garage we cannot match simply gets no note.
ALTER TABLE "Garage" ADD COLUMN "ghlContactId" TEXT;
