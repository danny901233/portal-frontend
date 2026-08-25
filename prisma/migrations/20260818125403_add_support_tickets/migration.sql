-- Support hub — Phase 2 (ticket model)
-- Hand-written (Prisma auto-migrate is blocked on this branch by pre-existing
-- schema drift, see GH #357). Purely additive: 5 new enums + 3 new tables +
-- indexes + foreign keys. No changes to any existing table. Safe to apply on prod.
--
-- Updated 2026-08-24 per Dan's PR #381 review:
--   #1 Ticket_contactId_fkey ON DELETE RESTRICT (was CASCADE) — history preserved,
--      use Contact.blocked=true for spam sender cleanup instead of hard deletion.
--   #3 status/category/priority/channel/kind promoted from TEXT to proper enums —
--      DB rejects invalid values instead of silently accepting 'Open' vs 'open'.
--   #5 (minor) TicketEntry indexes on authorUserId and authorContactId.

-- CreateEnum
CREATE TYPE "TicketStatus"    AS ENUM ('new', 'open', 'pending', 'on_hold', 'solved', 'closed');
CREATE TYPE "TicketCategory"  AS ENUM ('billing', 'agent_bug', 'setup_help', 'sales_enquiry', 'complaint', 'other', 'uncategorized');
CREATE TYPE "TicketPriority"  AS ENUM ('low', 'normal', 'high', 'urgent');
CREATE TYPE "TicketChannel"   AS ENUM ('email', 'whatsapp', 'portal_chat', 'phone');
CREATE TYPE "TicketEntryKind" AS ENUM ('public_reply', 'internal_note', 'status_change', 'assignment_change', 'auto_ack');

-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "name" TEXT,
    "garageId" TEXT,
    "userId" TEXT,
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Contact_email_key" ON "Contact"("email");
CREATE INDEX "Contact_phone_idx" ON "Contact"("phone");
CREATE INDEX "Contact_garageId_idx" ON "Contact"("garageId");
CREATE INDEX "Contact_userId_idx" ON "Contact"("userId");

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_garageId_fkey"
  FOREIGN KEY ("garageId") REFERENCES "Garage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "Ticket" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "status" "TicketStatus" NOT NULL DEFAULT 'new',
    "category" "TicketCategory" NOT NULL DEFAULT 'uncategorized',
    "priority" "TicketPriority" NOT NULL DEFAULT 'normal',
    "channel" "TicketChannel" NOT NULL,
    "contactId" TEXT NOT NULL,
    "garageId" TEXT,
    "assigneeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "firstResponseAt" TIMESTAMP(3),
    "lastCustomerActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastStaffActivityAt" TIMESTAMP(3),
    "solvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_number_key" ON "Ticket"("number");
CREATE INDEX "Ticket_status_updatedAt_idx" ON "Ticket"("status", "updatedAt");
CREATE INDEX "Ticket_assigneeId_status_idx" ON "Ticket"("assigneeId", "status");
CREATE INDEX "Ticket_contactId_createdAt_idx" ON "Ticket"("contactId", "createdAt");
CREATE INDEX "Ticket_channel_status_idx" ON "Ticket"("channel", "status");
CREATE INDEX "Ticket_garageId_status_idx" ON "Ticket"("garageId", "status");

-- AddForeignKey
-- #1 (Dan review): ON DELETE RESTRICT — cannot delete a Contact that still has tickets.
-- Preserves history; spam cleanup should use Contact.blocked=true instead.
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_contactId_fkey"
  FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_garageId_fkey"
  FOREIGN KEY ("garageId") REFERENCES "Garage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_assigneeId_fkey"
  FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "TicketEntry" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "kind" "TicketEntryKind" NOT NULL,
    "authorUserId" TEXT,
    "authorContactId" TEXT,
    "body" TEXT NOT NULL,
    "isDraft" BOOLEAN NOT NULL DEFAULT false,
    "outboundMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TicketEntry_ticketId_createdAt_idx" ON "TicketEntry"("ticketId", "createdAt");
CREATE INDEX "TicketEntry_outboundMessageId_idx" ON "TicketEntry"("outboundMessageId");
-- #5 (Dan review, minor): indexes for "everything X replied to" queries.
CREATE INDEX "TicketEntry_authorUserId_idx" ON "TicketEntry"("authorUserId");
CREATE INDEX "TicketEntry_authorContactId_idx" ON "TicketEntry"("authorContactId");

-- AddForeignKey
ALTER TABLE "TicketEntry" ADD CONSTRAINT "TicketEntry_ticketId_fkey"
  FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TicketEntry" ADD CONSTRAINT "TicketEntry_authorUserId_fkey"
  FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TicketEntry" ADD CONSTRAINT "TicketEntry_authorContactId_fkey"
  FOREIGN KEY ("authorContactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
