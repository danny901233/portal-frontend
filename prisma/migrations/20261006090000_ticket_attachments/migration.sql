-- Files staff attach to an outbound ticket email.
--
-- ticketEntryId is nullable on purpose: an upload is staged before the message that carries it
-- exists, and is claimed when the reply sends. Unclaimed rows are swept after 24h.
CREATE TABLE "TicketAttachment" (
    "id" TEXT NOT NULL,
    "ticketEntryId" TEXT,
    "s3Key" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "uploadedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketAttachment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TicketAttachment_ticketEntryId_idx" ON "TicketAttachment"("ticketEntryId");
CREATE INDEX "TicketAttachment_ticketEntryId_createdAt_idx" ON "TicketAttachment"("ticketEntryId", "createdAt");

ALTER TABLE "TicketAttachment" ADD CONSTRAINT "TicketAttachment_ticketEntryId_fkey"
    FOREIGN KEY ("ticketEntryId") REFERENCES "TicketEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TicketAttachment" ADD CONSTRAINT "TicketAttachment_uploadedByUserId_fkey"
    FOREIGN KEY ("uploadedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
