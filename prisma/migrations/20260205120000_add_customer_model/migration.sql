-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "garageId" TEXT NOT NULL,
    "name" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "whatsappId" TEXT,
    "facebookUserId" TEXT,
    "instagramUserId" TEXT,
    "notes" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- Rename existing customerId to platformUserId in ChatConversation
ALTER TABLE "ChatConversation" RENAME COLUMN "customerId" TO "platformUserId";

-- Add new customerId column that references Customer table
ALTER TABLE "ChatConversation" ADD COLUMN "customerId" TEXT;

-- CreateIndex
CREATE INDEX "Customer_garageId_idx" ON "Customer"("garageId");
CREATE INDEX "Customer_garageId_phone_idx" ON "Customer"("garageId", "phone");
CREATE INDEX "Customer_garageId_email_idx" ON "Customer"("garageId", "email");
CREATE INDEX "ChatConversation_garageId_customerId_idx" ON "ChatConversation"("garageId", "customerId");

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_garageId_fkey" FOREIGN KEY ("garageId") REFERENCES "Garage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatConversation" ADD CONSTRAINT "ChatConversation_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
