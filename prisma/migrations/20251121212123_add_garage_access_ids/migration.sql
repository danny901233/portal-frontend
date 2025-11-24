-- AlterTable
ALTER TABLE "User" ADD COLUMN     "garageAccessIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
