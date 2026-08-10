-- AlterTable
ALTER TABLE "AgentConfiguration" ADD COLUMN "allowBookings" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "bookingLeadTimeDays" INTEGER NOT NULL DEFAULT 1;
