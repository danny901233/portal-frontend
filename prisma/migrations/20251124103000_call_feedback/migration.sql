-- CreateTable
CREATE TABLE "CallFeedback" (
    "id" TEXT NOT NULL,
    "callId" TEXT NOT NULL,
    "rating" TEXT NOT NULL,
    "reasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CallFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CallFeedback_callId_key" ON "CallFeedback"("callId");

-- AddForeignKey
ALTER TABLE "CallFeedback" ADD CONSTRAINT "CallFeedback_callId_fkey" FOREIGN KEY ("callId") REFERENCES "Call"("id") ON DELETE CASCADE ON UPDATE CASCADE;
