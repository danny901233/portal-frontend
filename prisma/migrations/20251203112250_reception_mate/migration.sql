/*
  Warnings:

  - The `confirmedBookingCategory` column on the `Call` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- CreateEnum
CREATE TYPE "ConfirmedBookingCategory" AS ENUM ('service', 'diagnostic', 'mot', 'other');

-- AlterTable
ALTER TABLE "Call" DROP COLUMN "confirmedBookingCategory",
ADD COLUMN     "confirmedBookingCategory" "ConfirmedBookingCategory";
