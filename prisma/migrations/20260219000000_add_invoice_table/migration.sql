-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "garageId" TEXT NOT NULL,
    "businessId" TEXT,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "minutesUsed" INTEGER NOT NULL DEFAULT 0,
    "minutesIncluded" INTEGER NOT NULL DEFAULT 0,
    "smsCount" INTEGER NOT NULL DEFAULT 0,
    "subscriptionAmount" INTEGER NOT NULL,
    "minutesAmount" INTEGER NOT NULL DEFAULT 0,
    "smsAmount" INTEGER NOT NULL DEFAULT 0,
    "subtotal" INTEGER NOT NULL,
    "vatAmount" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "subscriptionCostGbp" DOUBLE PRECISION NOT NULL,
    "costPerMinuteGbp" DOUBLE PRECISION NOT NULL,
    "vatRate" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "gocardlessPaymentId" TEXT,
    "paidAt" TIMESTAMP(3),
    "creditReason" TEXT,
    "creditedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Invoice_garageId_periodStart_idx" ON "Invoice"("garageId", "periodStart");

-- CreateIndex
CREATE INDEX "Invoice_businessId_periodStart_idx" ON "Invoice"("businessId", "periodStart");

-- CreateIndex
CREATE INDEX "Invoice_status_idx" ON "Invoice"("status");

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_garageId_fkey" FOREIGN KEY ("garageId") REFERENCES "Garage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
